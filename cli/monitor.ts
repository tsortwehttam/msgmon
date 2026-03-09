import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { google, type gmail_v1 } from "googleapis"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { DEFAULT_ACCOUNT, resolveCredentialsPath, resolveTokenReadPathForAccount } from "../src/CliConfig"
import type { Argv } from "yargs"
import { verboseLog } from "../src/Verbose"

type MonitorState = {
  processed: Record<string, string>
}

let loadOAuth = (account: string, verbose = false) => {
  let credentialsPath = resolveCredentialsPath()
  let tokenPath = resolveTokenReadPathForAccount(account)
  verboseLog(verbose, "monitor auth", { account, credentialsPath, tokenPath })

  let raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
  let c = raw.installed ?? raw.web
  if (!c?.client_id || !c?.client_secret) throw new Error("Bad credentials.json (missing client_id/client_secret)")
  let o = new google.auth.OAuth2(c.client_id, c.client_secret, (c.redirect_uris ?? [])[0])
  let t = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
  o.setCredentials(t)
  return o
}

let gmail = (account: string, verbose = false) => google.gmail({ version: "v1", auth: loadOAuth(account, verbose) })

let sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let decodeBase64Url = (value?: string) => {
  if (!value) return ""
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, "base64").toString("utf8")
}

let headerMap = (msg: gmail_v1.Schema$Message) => {
  let out: Record<string, string> = {}
  for (let h of msg.payload?.headers ?? []) {
    if (!h.name || h.value == null) continue
    out[h.name.toLowerCase()] = h.value
  }
  return out
}

let pickBody = (part?: gmail_v1.Schema$MessagePart): { text?: string; html?: string } => {
  if (!part) return {}
  if (part.mimeType === "text/plain") return { text: decodeBase64Url(part.body?.data) }
  if (part.mimeType === "text/html") return { html: decodeBase64Url(part.body?.data) }
  for (let child of part.parts ?? []) {
    let found = pickBody(child)
    if (found.text || found.html) return found
  }
  return {}
}

type FoundAttachment = {
  filename: string
  mimeType?: string
  attachmentId?: string
  inlineData?: string
}

let collectAttachments = (part?: gmail_v1.Schema$MessagePart, out: FoundAttachment[] = []) => {
  if (!part) return out
  if (part.filename) {
    out.push({
      filename: part.filename,
      mimeType: part.mimeType ?? undefined,
      attachmentId: part.body?.attachmentId ?? undefined,
      inlineData: part.body?.data ?? undefined,
    })
  }
  for (let child of part.parts ?? []) collectAttachments(child, out)
  return out
}

let sanitizeFileName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 200) || "file"

let uniquePath = (dir: string, baseName: string) => {
  let ext = path.extname(baseName)
  let name = path.basename(baseName, ext)
  let candidate = path.resolve(dir, baseName)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.resolve(dir, `${name}_${i}${ext}`)
    i += 1
  }
  return candidate
}

let runAgent = async (command: string, cwd: string, env: Record<string, string | undefined>) =>
  new Promise<void>((resolve, reject) => {
    let child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", code => {
      if (code === 0) return resolve()
      reject(new Error(`Agent command failed with exit code ${code ?? "unknown"}`))
    })
  })

let readState = (statePath: string): MonitorState => {
  if (!fs.existsSync(statePath)) return { processed: {} }
  try {
    let data = JSON.parse(fs.readFileSync(statePath, "utf8"))
    if (!data || typeof data !== "object" || typeof data.processed !== "object") return { processed: {} }
    return { processed: data.processed }
  } catch {
    return { processed: {} }
  }
}

let writeState = (statePath: string, state: MonitorState) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

let runMonitor = async (params: {
  account: string
  query: string
  intervalMs: number
  maxResults: number
  agentCmd: string
  prompt?: string
  promptFile?: string
  agentsMd?: string
  workRoot: string
  statePath: string
  markRead: boolean
  verbose: boolean
}) => {
  let client = gmail(params.account, params.verbose)
  let state = readState(params.statePath)

  let promptParts = [params.prompt ?? ""]
  if (params.promptFile) promptParts.push(fs.readFileSync(path.resolve(params.promptFile), "utf8"))
  let promptText = promptParts.join("\n\n").trim()

  verboseLog(params.verbose, "monitor config", {
    account: params.account,
    query: params.query,
    intervalMs: params.intervalMs,
    maxResults: params.maxResults,
    statePath: params.statePath,
    workRoot: params.workRoot,
    markRead: params.markRead,
  })

  while (true) {
    let listed = await client.users.messages.list({
      userId: "me",
      q: params.query,
      maxResults: params.maxResults,
    })
    let refs = (listed.data.messages ?? []).filter(x => x.id).reverse()
    verboseLog(params.verbose, "monitor iteration", { matched: refs.length, query: params.query })

    for (let ref of refs) {
      if (!ref.id) continue
      if (state.processed[ref.id]) continue

      let msgResponse = await client.users.messages.get({ userId: "me", id: ref.id, format: "full" })
      let msg = msgResponse.data
      let headers = headerMap(msg)
      let safeSubject = sanitizeFileName(headers.subject ?? "no_subject")
      let stamp = new Date().toISOString().replace(/[:.]/g, "-")
      let runDir = path.resolve(params.workRoot, `${stamp}_${ref.id}_${safeSubject}`)
      let attachmentsDir = path.resolve(runDir, "attachments")
      fs.mkdirSync(attachmentsDir, { recursive: true })

      fs.writeFileSync(path.resolve(runDir, "message.json"), `${JSON.stringify(msg, null, 2)}\n`)
      fs.writeFileSync(path.resolve(runDir, "headers.json"), `${JSON.stringify(headers, null, 2)}\n`)

      let body = pickBody(msg.payload ?? undefined)
      if (body.text) fs.writeFileSync(path.resolve(runDir, "body.txt"), body.text)
      if (body.html) fs.writeFileSync(path.resolve(runDir, "body.html"), body.html)
      if (!body.text && !body.html) fs.writeFileSync(path.resolve(runDir, "body.txt"), "")

      for (let att of collectAttachments(msg.payload ?? undefined)) {
        let safeName = sanitizeFileName(att.filename)
        let outPath = uniquePath(attachmentsDir, safeName)
        let rawData = att.inlineData
        if (!rawData && att.attachmentId) {
          let fetched = await client.users.messages.attachments.get({
            userId: "me",
            messageId: ref.id,
            id: att.attachmentId,
          })
          rawData = fetched.data.data ?? undefined
        }
        if (!rawData) continue
        let normalized = rawData.replace(/-/g, "+").replace(/_/g, "/")
        let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
        fs.writeFileSync(outPath, Buffer.from(padded, "base64"))
      }

      if (params.agentsMd) {
        let source = path.resolve(params.agentsMd)
        fs.copyFileSync(source, path.resolve(runDir, "AGENTS.md"))
      }

      let task = [
        "# Mailmon Task",
        "",
        "You are processing one Gmail message exported by `mailmon monitor`.",
        "Available artifacts in this directory:",
        "- `message.json` (full Gmail message payload)",
        "- `headers.json`",
        "- `body.txt` and/or `body.html`",
        "- `attachments/`",
        "",
        "You can invoke `mailmon` as needed for follow-up actions.",
        "",
        "## User Prompt",
        promptText || "(No prompt provided)",
        "",
      ].join("\n")
      fs.writeFileSync(path.resolve(runDir, "TASK.md"), task)

      verboseLog(params.verbose, "running agent", { messageId: ref.id, runDir, command: params.agentCmd })
      await runAgent(params.agentCmd, runDir, {
        MAILMON_RUN_DIR: runDir,
        MAILMON_MESSAGE_ID: ref.id,
        MAILMON_THREAD_ID: msg.threadId ?? "",
        MAILMON_ACCOUNT: params.account,
      })

      if (params.markRead) {
        await client.users.messages.modify({
          userId: "me",
          id: ref.id,
          requestBody: { removeLabelIds: ["UNREAD"] },
        })
      }

      state.processed[ref.id] = new Date().toISOString()
      writeState(params.statePath, state)
      console.log(
        JSON.stringify(
          {
            processedAt: state.processed[ref.id],
            account: params.account,
            messageId: ref.id,
            threadId: msg.threadId ?? null,
            runDir,
          },
          null,
          2,
        ),
      )
    }

    await sleep(params.intervalMs)
  }
}

export let configureMonitorCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .option("account", {
      type: "string",
      default: DEFAULT_ACCOUNT,
      describe: "Token account name (uses .mailmon/tokens/<account>.json)",
    })
    .option("query", {
      type: "string",
      default: "is:unread",
      describe: "Gmail search query to monitor",
    })
    .option("interval-ms", {
      type: "number",
      default: 5000,
      coerce: value => {
        if (!Number.isFinite(value) || value <= 0) throw new Error("--interval-ms must be a positive number")
        return Math.floor(value)
      },
      describe: "Polling interval in milliseconds",
    })
    .option("max-results", {
      type: "number",
      default: 20,
      coerce: value => {
        if (!Number.isFinite(value) || value < 1 || value > 500) throw new Error("--max-results must be 1..500")
        return Math.floor(value)
      },
      describe: "Maximum matched messages to check per poll cycle",
    })
    .option("agent-cmd", {
      type: "string",
      demandOption: true,
      describe: "Shell command to execute for each newly seen message",
    })
    .option("prompt", {
      type: "string",
      describe: "Prompt text to include in TASK.md for every message",
    })
    .option("prompt-file", {
      type: "string",
      describe: "Path to prompt file to include in TASK.md for every message",
    })
    .option("agents-md", {
      type: "string",
      describe: "Optional AGENTS.md file to copy into each run directory",
    })
    .option("work-root", {
      type: "string",
      default: path.resolve(os.tmpdir(), "mailmon"),
      describe: "Root directory where per-message run directories are created",
    })
    .option("state", {
      type: "string",
      default: "",
      describe: "Path to JSON file tracking processed message ids (default: ./.mailmon/state/monitor-<account>.json)",
    })
    .option("mark-read", {
      type: "boolean",
      default: false,
      describe: "Mark messages as read after successful agent processing",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .example(
      "$0 --account=personal --query='in:inbox is:unread' --agent-cmd='codex run \"Read TASK.md and process.\"'",
      "Monitor unread messages and run a coding agent for each new match",
    )
    .example("$0 --agent-cmd='./my-agent.sh' --prompt-file=./prompt.md --agents-md=./AGENTS.md", "Use local prompt and AGENTS instructions for each run")
    .epilog(
      [
        "Behavior:",
        "- Polls Gmail continuously using `--query`.",
        "- For each unprocessed message id, creates a run directory under `--work-root`.",
        "- Writes `message.json`, message body files, and attachment files, then executes `--agent-cmd` in that run directory.",
        "- Tracks processed message ids in `--state`.",
      ].join("\n"),
    )
    .strict()
    .help()

export let parseMonitorCli = (args: string[], scriptName = "monitor") =>
  configureMonitorCli(yargs(args).scriptName(scriptName))
    .parseAsync()
    .then(argv =>
      runMonitor({
        account: argv.account,
        query: argv.query,
        intervalMs: argv.intervalMs,
        maxResults: argv.maxResults,
        agentCmd: argv.agentCmd,
        prompt: argv.prompt,
        promptFile: argv.promptFile,
        agentsMd: argv.agentsMd,
        workRoot: path.resolve(argv.workRoot),
        statePath: argv.state
          ? path.resolve(argv.state)
          : path.resolve(process.cwd(), ".mailmon", "state", `monitor-${argv.account}.json`),
        markRead: argv.markRead,
        verbose: argv.verbose,
      }),
    )

export let runMonitorCli = (args = hideBin(process.argv), scriptName = "monitor") =>
  parseMonitorCli(args, scriptName).catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runMonitorCli()
}

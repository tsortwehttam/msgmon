import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { DEFAULT_ACCOUNT, resolveCredentialsPath, resolveTokenReadPathForAccount } from "../src/CliConfig"
import { buildCorpus } from "../src/CorpusBuilder"
import { buildRunDirName, collectAttachments, decodeBase64Url, exportMessageArtifacts, headerMap, pickBody } from "../src/MessageExport"
import type { Argv } from "yargs"
import { verboseLog } from "../src/Verbose"

let loadOAuth = (account: string, verbose = false) => {
  let credentialsPath = resolveCredentialsPath()
  let tokenPath = resolveTokenReadPathForAccount(account)
  verboseLog(verbose, "mail auth", { account, credentialsPath, tokenPath })

  let raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
  let c = raw.installed ?? raw.web
  if (!c?.client_id || !c?.client_secret) throw new Error("Bad credentials.json (missing client_id/client_secret)")
  let o = new google.auth.OAuth2(c.client_id, c.client_secret, (c.redirect_uris ?? [])[0])
  let t = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
  o.setCredentials(t)
  return o
}

let gmail = (account: string, verbose = false) => google.gmail({ version: "v1", auth: loadOAuth(account, verbose) })

let base64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

let chunk76 = (s: string) => (s.match(/.{1,76}/g) ?? []).join("\r\n")

let encodeQuotedPrintable = (input: string) => {
  let lines = input.split(/\r?\n/)
  let encoded: string[] = []
  for (let line of lines) {
    let current = ""
    for (let i = 0; i < line.length; i++) {
      let char = line[i]
      let code = line.charCodeAt(i)
      let bytes = Buffer.from(char, "utf8")
      let chunk: string
      if (bytes.length === 1 && code >= 33 && code <= 126 && code !== 61) {
        chunk = char
      } else if ((code === 9 || code === 32) && i < line.length - 1) {
        chunk = char
      } else {
        chunk = Array.from(bytes)
          .map(x => `=${x.toString(16).toUpperCase().padStart(2, "0")}`)
          .join("")
      }
      if (current.length + chunk.length > 75) {
        encoded.push(current + "=")
        current = chunk
      } else {
        current += chunk
      }
    }
    encoded.push(current)
  }
  return encoded.join("\r\n")
}

let normalizeMessageId = (value?: string) => {
  let trimmed = (value ?? "").trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed
  if (!trimmed.includes("@")) return undefined
  return `<${trimmed}>`
}

let dedupeReferences = (value?: string) => {
  let refs = (value ?? "")
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x.startsWith("<") && x.endsWith(">") ? x : normalizeMessageId(x) ?? `<${x}>`))
  return Array.from(new Set(refs)).join(" ")
}

let buildMessageId = (from?: string) => {
  let domain = from?.split("@")[1] ?? "localhost"
  return `<${crypto.randomBytes(12).toString("hex")}.${Date.now()}@${domain}>`
}

let guessMimeType = (filePath: string) => {
  let ext = path.extname(filePath).toLowerCase()
  if (ext === ".txt") return "text/plain"
  if (ext === ".html" || ext === ".htm") return "text/html"
  if (ext === ".json") return "application/json"
  if (ext === ".pdf") return "application/pdf"
  if (ext === ".csv") return "text/csv"
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  return "application/octet-stream"
}

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let stripHtml = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

let bodyText = (msg: { payload?: import("googleapis").gmail_v1.Schema$MessagePart }) => {
  let body = pickBody(msg.payload ?? undefined)
  if (body.text) return body.text
  if (body.html) return stripHtml(body.html)
  return ""
}

let formatMessageText = (msg: import("googleapis").gmail_v1.Schema$Message) => {
  let headers = headerMap(msg)
  let lines = [
    `From: ${headers.from ?? ""}`,
    `To: ${headers.to ?? ""}`,
    `Date: ${headers.date ?? ""}`,
    `Subject: ${headers.subject ?? ""}`,
    "",
    bodyText(msg),
  ]
  return lines.join("\n")
}

type ExportState = {
  exported: Record<string, string>
}

let readExportState = (statePath: string): ExportState => {
  if (!fs.existsSync(statePath)) return { exported: {} }
  try {
    let data = JSON.parse(fs.readFileSync(statePath, "utf8"))
    if (!data || typeof data !== "object" || typeof data.exported !== "object") return { exported: {} }
    return { exported: data.exported }
  } catch {
    return { exported: {} }
  }
}

let writeExportState = (statePath: string, state: ExportState) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

let appendJsonl = (outPath: string, record: unknown) => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`)
}

let quoteGmailTerm = (value: string) => `"${value.replace(/"/g, '\\"')}"`
let DEFAULT_EXPORT_MAX_MESSAGES = 100

let buildDefaultExportStatePath = (params: { account: string; query: string; outDir: string }) => {
  let key = JSON.stringify({
    account: params.account,
    query: params.query,
    outDir: params.outDir,
  })
  let digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
  return path.resolve(process.cwd(), ".mailmon", "state", `export-${params.account}-${digest}.json`)
}

let buildExportQuery = (params: {
  scope: "primary" | "inbox" | "all-mail"
  from: string[]
  to: string[]
  label: string[]
  newerThan?: string
  olderThan?: string
  after?: string
  before?: string
  hasAttachment: boolean
  includeRead: "any" | "unread" | "read"
  query?: string
}) => {
  let terms: string[] = []
  if (params.scope === "primary") terms.push("in:inbox", "category:primary")
  if (params.scope === "inbox") terms.push("in:inbox")
  for (let value of params.from) terms.push(`from:${quoteGmailTerm(value)}`)
  for (let value of params.to) terms.push(`to:${quoteGmailTerm(value)}`)
  for (let value of params.label) terms.push(`label:${quoteGmailTerm(value)}`)
  if (params.newerThan) terms.push(`newer_than:${params.newerThan}`)
  if (params.olderThan) terms.push(`older_than:${params.olderThan}`)
  if (params.after) terms.push(`after:${params.after}`)
  if (params.before) terms.push(`before:${params.before}`)
  if (params.hasAttachment) terms.push("has:attachment")
  if (params.includeRead === "unread") terms.push("is:unread")
  if (params.includeRead === "read") terms.push("-is:unread")
  let rawQuery = (params.query ?? "").trim()
  if (rawQuery) terms.push(rawQuery)
  return terms.join(" ").trim()
}

let iterateMessageRefs = async function* (params: {
  client: ReturnType<typeof gmail>
  query: string
  pageSize: number
  includeSpamTrash: boolean
  verbose: boolean
}) {
  let pageToken: string | undefined

  while (true) {
    let response = await params.client.users.messages.list({
      userId: "me",
      q: params.query || undefined,
      maxResults: params.pageSize,
      pageToken,
      includeSpamTrash: params.includeSpamTrash,
    })

    let pageRefs = (response.data.messages ?? []).filter(message => message.id).map(message => ({
      id: message.id as string,
      threadId: message.threadId ?? null,
    }))
    verboseLog(params.verbose, "export page", {
      fetched: pageRefs.length,
      nextPageToken: response.data.nextPageToken ?? null,
    })

    for (let ref of pageRefs) yield ref

    pageToken = response.data.nextPageToken ?? undefined
    if (!pageToken) break
  }
}

let buildRawMessage = (params: {
  from?: string
  to: string
  cc: string[]
  bcc: string[]
  replyTo?: string
  inReplyTo?: string
  references?: string
  messageId?: string
  subject: string
  body: string
  attach: string[]
}) => {
  let normalizedInReplyTo = normalizeMessageId(params.inReplyTo)
  let normalizedReferences = dedupeReferences(
    [params.references, normalizedInReplyTo].filter(Boolean).join(" ").trim() || undefined,
  )
  let headers = [
    ...(params.from ? [`From: ${params.from}`] : []),
    `To: ${params.to}`,
    ...(params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc.length > 0 ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    ...(params.replyTo ? [`Reply-To: ${params.replyTo}`] : []),
    ...(normalizedInReplyTo ? [`In-Reply-To: ${normalizedInReplyTo}`] : []),
    ...(normalizedReferences ? [`References: ${normalizedReferences}`] : []),
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${normalizeMessageId(params.messageId) ?? buildMessageId(params.from)}`,
    "MIME-Version: 1.0",
    "X-Mailer: mailmon/1.0",
  ]

  if (params.attach.length === 0) {
    return (
      headers.join("\r\n") +
      `\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(params.body)}`
    )
  }

  let boundary = `mailmon_${Date.now()}_${Math.random().toString(36).slice(2)}`
  let parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(params.body)}\r\n`,
    ...params.attach.map(filePath => {
      let filename = path.basename(filePath).replace(/"/g, "")
      let content = fs.readFileSync(filePath).toString("base64")
      return (
        `--${boundary}\r\n` +
        `Content-Type: ${guessMimeType(filePath)}; name="${filename}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n" +
        `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
        `${chunk76(content)}\r\n`
      )
    }),
    `--${boundary}--`,
  ]

  return headers.join("\r\n") + `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` + parts.join("")
}

export let configureMailCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .option("account", {
      type: "string",
      default: DEFAULT_ACCOUNT,
      describe: "Token account name (uses .mailmon/tokens/<account>.json)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .command(
    "search [query]",
    "Search messages by Gmail query; returns refs or hydrated message payloads",
    y =>
      y
        .positional("query", {
          type: "string",
          describe: 'Gmail query, e.g. "from:someone newer_than:7d"',
        })
        .option("max-results", {
          type: "number",
          default: 20,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1 || value > 500) throw new Error("--max-results must be 1..500")
            return Math.floor(value)
          },
          describe: "Maximum matched messages to return",
        })
        .option("fetch", {
          type: "string",
          default: "none",
          choices: ["none", "metadata", "full", "summary"] as const,
          describe: "Fetch matched message payloads: none, metadata, full, or summary (headers + truncated body)",
        })
        .option("format", {
          type: "string",
          default: "json",
          choices: ["json", "summary"] as const,
          describe: "Output format: json (default) or summary (compact date/from/subject/snippet view)",
        })
        .option("preview-chars", {
          type: "number",
          default: 200,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1) throw new Error("--preview-chars must be positive")
            return Math.floor(value)
          },
          describe: "Maximum body preview characters when --fetch=summary",
        })
        .check(argv => {
          if (!argv.query) throw new Error("A query is required: pass as positional arg or --query")
          return true
        }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let effectiveFetch = argv.fetch
      if (argv.format === "summary" && effectiveFetch === "none") effectiveFetch = "metadata"
      let r = await client.users.messages.list({ userId: "me", q: argv.query, maxResults: argv.maxResults })
      let resultSizeEstimate = r.data.resultSizeEstimate ?? 0
      let msgs = r.data.messages ?? []
      let resolvedMessages: unknown[] | undefined
      if (effectiveFetch !== "none") {
        resolvedMessages = []
        let fetchFormat = effectiveFetch === "summary" ? "full" : effectiveFetch
        for (let message of msgs) {
          if (!message.id) continue
          let fetched = await client.users.messages.get({
            userId: "me",
            id: message.id,
            format: fetchFormat,
            ...(fetchFormat === "metadata"
              ? { metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"] }
              : {}),
          })
          if (effectiveFetch === "summary") {
            let headers = headerMap(fetched.data)
            let preview = bodyText(fetched.data)
            if (preview.length > argv.previewChars) preview = preview.slice(0, argv.previewChars) + "..."
            resolvedMessages.push({
              id: fetched.data.id,
              threadId: fetched.data.threadId,
              from: headers.from ?? "",
              to: headers.to ?? "",
              subject: headers.subject ?? "",
              date: headers.date ?? "",
              snippet: fetched.data.snippet ?? "",
              bodyPreview: preview,
            })
          } else {
            resolvedMessages.push(fetched.data)
          }
        }
      }
      verboseLog(argv.verbose, "search results", { count: msgs.length, fetch: effectiveFetch, resultSizeEstimate })

      if (argv.format === "summary") {
        console.log(`${resultSizeEstimate} estimated results, showing ${msgs.length}`)
        console.log("")
        let items = resolvedMessages ?? msgs
        for (let item of items) {
          let m = item as Record<string, unknown>
          if (m.from || m.subject) {
            let date = (m.date as string ?? "").replace(/\s*\(.*\)$/, "")
            console.log(`  ${m.id}  ${date}  ${m.from}`)
            console.log(`    ${m.subject}`)
            if (m.bodyPreview) console.log(`    ${(m.bodyPreview as string).split("\n")[0]}`)
            else if (m.snippet) console.log(`    ${m.snippet}`)
          } else {
            let headers = headerMap(m as import("googleapis").gmail_v1.Schema$Message)
            let date = (headers.date ?? "").replace(/\s*\(.*\)$/, "")
            let snippet = (m.snippet as string) ?? ""
            console.log(`  ${m.id}  ${date}  ${headers.from ?? ""}`)
            console.log(`    ${headers.subject ?? "(no subject)"}`)
            if (snippet) console.log(`    ${snippet}`)
          }
          console.log("")
        }
        return
      }

      console.log(
        JSON.stringify(
          {
            query: argv.query,
            resultSizeEstimate,
            returned: msgs.length,
            messages: msgs,
            ...(resolvedMessages ? { resolvedMessages } : {}),
          },
          null,
          2,
        ),
      )
    },
    )
    .command(
    "count <query>",
    "Return Gmail's resultSizeEstimate for a query",
    y =>
      y.positional("query", {
        type: "string",
        describe: 'Gmail query, e.g. "from:someone newer_than:7d"',
      }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let response = await client.users.messages.list({
        userId: "me",
        q: argv.query,
        maxResults: 1,
      })
      console.log(
        JSON.stringify(
          {
            account: argv.account,
            query: argv.query,
            resultSizeEstimate: response.data.resultSizeEstimate ?? 0,
          },
          null,
          2,
        ),
      )
    },
    )
    .command(
    "thread <threadId>",
    "Fetch all messages in a Gmail thread in chronological order",
    y =>
      y
        .positional("threadId", {
          type: "string",
          describe: "Gmail thread id",
        })
        .option("format", {
          type: "string",
          default: "json",
          choices: ["json", "text"] as const,
          describe: "Output format: json (full API response) or text (human-readable conversation)",
        }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let r = await client.users.threads.get({
        userId: "me",
        id: argv.threadId,
        format: "full",
      })
      verboseLog(argv.verbose, "thread", { id: argv.threadId, messageCount: r.data.messages?.length ?? 0 })

      if (argv.format === "text") {
        let messages = r.data.messages ?? []
        console.log(`Thread: ${argv.threadId} (${messages.length} message${messages.length === 1 ? "" : "s"})`)
        console.log("=".repeat(60))
        for (let i = 0; i < messages.length; i++) {
          let msg = messages[i]
          if (i > 0) console.log("-".repeat(60))
          console.log(formatMessageText(msg))
        }
        return
      }

      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "export",
    "Export matched messages into per-message directories",
    y =>
      y
        .option("out-dir", {
          type: "string",
          demandOption: true,
          describe: "Directory where exported message folders will be created",
        })
        .option("scope", {
          type: "string",
          default: "primary",
          choices: ["primary", "inbox", "all-mail"] as const,
          describe: "Default mailbox scope: Primary inbox, all inbox mail, or all mail",
        })
        .option("query", {
          type: "string",
          describe: "Additional raw Gmail query terms appended to the generated filter query",
        })
        .option("from", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "Filter sender(s), repeat flag or pass comma-separated values",
        })
        .option("to", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "Filter recipient(s), repeat flag or pass comma-separated values",
        })
        .option("label", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "Required Gmail label(s), repeat flag or pass comma-separated values",
        })
        .option("newer-than", {
          type: "string",
          describe: "Gmail relative age filter, for example 7d or 3m",
        })
        .option("older-than", {
          type: "string",
          describe: "Gmail relative age upper bound, for example 30d",
        })
        .option("after", {
          type: "string",
          describe: "Gmail date lower bound, for example 2025/01/01",
        })
        .option("before", {
          type: "string",
          describe: "Gmail date upper bound, for example 2025/02/01",
        })
        .option("read", {
          type: "string",
          default: "any",
          choices: ["any", "unread", "read"] as const,
          describe: "Read-state filter",
        })
        .option("has-attachment", {
          type: "boolean",
          default: false,
          describe: "Require attachments in matched messages",
        })
        .option("include-spam-trash", {
          type: "boolean",
          default: false,
          describe: "Include Spam and Trash in search results",
        })
        .option("page-size", {
          type: "number",
          default: 100,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1 || value > 500) throw new Error("--page-size must be 1..500")
            return Math.floor(value)
          },
          describe: "Gmail API page size while paginating through matches",
        })
        .option("max-messages", {
          type: "number",
          coerce: value => {
            if (value == null) return undefined
            if (!Number.isFinite(value) || value < 1) throw new Error("--max-messages must be a positive number")
            return Math.floor(value)
          },
          describe: `Optional cap on the number of new messages to export in this run (default: ${DEFAULT_EXPORT_MAX_MESSAGES} unless --all)`,
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe: "Export all matched messages by removing the default safety cap",
        })
        .option("resume", {
          type: "boolean",
          default: false,
          describe: "Resume from a default state file derived from account, query, and output directory",
        })
        .option("state", {
          type: "string",
          describe: "Optional explicit JSON state file path for incremental runs",
        })
        .option("jsonl-out", {
          type: "string",
          describe: "Optional JSONL manifest path; appends one record per exported or skipped message",
        }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let query = buildExportQuery({
        scope: argv.scope as "primary" | "inbox" | "all-mail",
        from: argv.from,
        to: argv.to,
        label: argv.label,
        newerThan: argv.newerThan,
        olderThan: argv.olderThan,
        after: argv.after,
        before: argv.before,
        hasAttachment: argv.hasAttachment,
        includeRead: argv.read as "any" | "unread" | "read",
        query: argv.query,
      })
      let outDir = path.resolve(argv.outDir)
      let jsonlOutPath = argv.jsonlOut ? path.resolve(argv.jsonlOut) : undefined
      let effectiveMaxMessages = argv.maxMessages ?? (argv.all ? undefined : DEFAULT_EXPORT_MAX_MESSAGES)
      let statePath = argv.state
        ? path.resolve(argv.state)
        : argv.resume
          ? buildDefaultExportStatePath({ account: argv.account, query, outDir })
          : undefined
      let state = statePath ? readExportState(statePath) : { exported: {} }

      verboseLog(argv.verbose, "export request", {
        account: argv.account,
        query,
        outDir,
        statePath: statePath ?? null,
        resume: argv.resume,
        jsonlOutPath: jsonlOutPath ?? null,
        pageSize: argv.pageSize,
        maxMessages: effectiveMaxMessages ?? null,
        all: argv.all,
        includeSpamTrash: argv.includeSpamTrash,
      })

      fs.mkdirSync(outDir, { recursive: true })

      let exported: Array<{ id: string; threadId?: string | null; dir: string }> = []
      let skipped: string[] = []
      let scannedCount = 0
      for await (let ref of iterateMessageRefs({
        client,
        query,
        pageSize: argv.pageSize,
        includeSpamTrash: argv.includeSpamTrash,
        verbose: argv.verbose,
      })) {
        if (effectiveMaxMessages != null && exported.length >= effectiveMaxMessages) break
        scannedCount += 1
        if (state.exported[ref.id]) {
          skipped.push(ref.id)
          if (jsonlOutPath) {
            appendJsonl(jsonlOutPath, {
              type: "message",
              status: "skipped",
              messageId: ref.id,
              threadId: ref.threadId ?? null,
              account: argv.account,
              query,
              skippedAt: new Date().toISOString(),
              reason: "already-exported",
            })
          }
          continue
        }

        let fetched = await client.users.messages.get({ userId: "me", id: ref.id, format: "full" })
        let headers = headerMap(fetched.data)
        let dir = path.resolve(outDir, buildRunDirName(ref.id, headers.subject))
        fs.mkdirSync(dir, { recursive: true })
        await exportMessageArtifacts({ client, messageId: ref.id, message: fetched.data, outDir: dir })

        state.exported[ref.id] = new Date().toISOString()
        if (statePath) writeExportState(statePath, state)
        exported.push({ id: ref.id, threadId: fetched.data.threadId ?? null, dir })
        if (jsonlOutPath) {
          appendJsonl(jsonlOutPath, {
            type: "message",
            status: "exported",
            messageId: ref.id,
            threadId: fetched.data.threadId ?? null,
            account: argv.account,
            query,
            exportedAt: state.exported[ref.id],
            dir,
          })
        }
      }

      console.log(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            account: argv.account,
            query,
            outDir,
            scannedCount,
            exportedCount: exported.length,
            skippedCount: skipped.length,
            all: argv.all,
            maxMessages: effectiveMaxMessages ?? null,
            statePath: statePath ?? null,
            jsonlOutPath: jsonlOutPath ?? null,
            exported,
            skipped,
          },
          null,
          2,
        ),
      )
    },
    )
    .command(
    "corpus",
    "Build an LLM-oriented corpus from mail export directories",
    y =>
      y
        .option("from-export", {
          type: "string",
          demandOption: true,
          describe: "Root directory produced by `mail export` containing per-message folders",
        })
        .option("out-dir", {
          type: "string",
          demandOption: true,
          describe: "Directory where corpus files will be written",
        })
        .option("chunk-chars", {
          type: "number",
          default: 4000,
          coerce: value => {
            if (!Number.isFinite(value) || value < 500) throw new Error("--chunk-chars must be >= 500")
            return Math.floor(value)
          },
          describe: "Maximum characters per chunk written to chunks.jsonl",
        })
        .option("chunk-overlap-chars", {
          type: "number",
          default: 400,
          coerce: value => {
            if (!Number.isFinite(value) || value < 0) throw new Error("--chunk-overlap-chars must be >= 0")
            return Math.floor(value)
          },
          describe: "Character overlap between adjacent chunks",
        })
        .option("max-attachment-bytes", {
          type: "number",
          default: 250000,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1) throw new Error("--max-attachment-bytes must be positive")
            return Math.floor(value)
          },
          describe: "Maximum bytes read from any one attachment when extracting text",
        })
        .option("max-attachment-chars", {
          type: "number",
          default: 20000,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1) throw new Error("--max-attachment-chars must be positive")
            return Math.floor(value)
          },
          describe: "Maximum normalized characters kept from any one attachment",
        })
        .option("thread-excerpt-chars", {
          type: "number",
          default: 500,
          coerce: value => {
            if (!Number.isFinite(value) || value < 50) throw new Error("--thread-excerpt-chars must be >= 50")
            return Math.floor(value)
          },
          describe: "Excerpt length per message embedded in threads.jsonl",
        }),
    async argv => {
      let summary = buildCorpus({
        exportDir: argv.fromExport,
        outDir: argv.outDir,
        chunkChars: argv.chunkChars,
        chunkOverlapChars: argv.chunkOverlapChars,
        maxAttachmentBytes: argv.maxAttachmentBytes,
        maxAttachmentChars: argv.maxAttachmentChars,
        threadExcerptChars: argv.threadExcerptChars,
        verbose: argv.verbose,
      })
      console.log(JSON.stringify(summary, null, 2))
    },
    )
    .command(
    "read <messageId>",
    "Read a message; returns JSON metadata or human-readable text with optional attachment download",
    y =>
      y
        .positional("messageId", {
          type: "string",
          describe: "Gmail message id",
        })
        .option("format", {
          type: "string",
          default: "json",
          choices: ["json", "text"] as const,
          describe: "Output format: json (metadata payload) or text (decoded headers + body)",
        })
        .option("save-attachments", {
          type: "string",
          describe: "Directory to save attachments to (downloads via Gmail attachments API)",
        }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let needFull = argv.format === "text" || argv.saveAttachments
      let r = await client.users.messages.get({
        userId: "me",
        id: argv.messageId,
        format: needFull ? "full" : "metadata",
        ...(!needFull ? { metadataHeaders: ["From", "To", "Subject", "Date"] } : {}),
      })
      verboseLog(argv.verbose, "read message", { id: argv.messageId, threadId: r.data.threadId })

      if (argv.saveAttachments) {
        let outDir = path.resolve(argv.saveAttachments)
        fs.mkdirSync(outDir, { recursive: true })
        let attachments = collectAttachments(r.data.payload ?? undefined)
        let saved: string[] = []
        for (let att of attachments) {
          let rawData = att.inlineData
          if (!rawData && att.attachmentId) {
            let fetched = await client.users.messages.attachments.get({
              userId: "me",
              messageId: argv.messageId!,
              id: att.attachmentId,
            })
            rawData = fetched.data.data ?? undefined
          }
          if (!rawData) continue
          let normalized = rawData.replace(/-/g, "+").replace(/_/g, "/")
          let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
          let safeName = att.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "file"
          let outPath = path.resolve(outDir, safeName)
          fs.writeFileSync(outPath, Buffer.from(padded, "base64"))
          saved.push(outPath)
        }
        verboseLog(argv.verbose, "saved attachments", { count: saved.length, dir: outDir })
        if (argv.format !== "text") {
          console.log(JSON.stringify({ ...r.data, savedAttachments: saved }, null, 2))
          return
        }
      }

      if (argv.format === "text") {
        console.log(formatMessageText(r.data))
        if (argv.saveAttachments) {
          let attachments = collectAttachments(r.data.payload ?? undefined)
          if (attachments.length > 0) {
            console.log(`\nAttachments saved to ${argv.saveAttachments}:`)
            for (let att of attachments) console.log(`  ${att.filename}`)
          }
        }
        return
      }

      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "send",
    "Send a message with optional cc/bcc/attachments/threading headers; returns Gmail send response JSON",
    y =>
      y
        .option("to", {
          type: "string",
          demandOption: true,
          describe: "Recipient email address",
        })
        .option("cc", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "CC recipient(s), repeat flag or pass comma-separated values",
        })
        .option("bcc", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "BCC recipient(s), repeat flag or pass comma-separated values",
        })
        .option("reply-to", {
          type: "string",
          describe: "Reply-To header value",
        })
        .option("from", {
          type: "string",
          describe: "Optional From header (must be authorized in Gmail sender settings)",
        })
        .option("thread-id", {
          type: "string",
          describe: "Gmail threadId for threading",
        })
        .option("in-reply-to", {
          type: "string",
          describe: "In-Reply-To header (RFC 822 Message-ID)",
        })
        .option("references", {
          type: "string",
          describe: "References header value",
        })
        .option("message-id", {
          type: "string",
          describe: "Optional Message-ID header override",
        })
        .option("subject", {
          type: "string",
          default: "",
          describe: "Message subject",
        })
        .option("body", {
          type: "string",
          default: "",
          describe: "Message body",
        })
        .option("attach", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "Attachment file path(s), repeat flag to include multiple",
        })
        .option("yes", {
          type: "boolean",
          default: false,
          describe: "Required safety flag to actually send",
        }),
    async argv => {
      if (!argv.yes) throw new Error("Refusing to send without --yes")
      verboseLog(argv.verbose, "send request", {
        account: argv.account,
        to: argv.to,
        ccCount: argv.cc.length,
        bccCount: argv.bcc.length,
        attachments: argv.attach,
        threadId: argv.threadId,
      })

      let raw = buildRawMessage({
        from: argv.from,
        to: argv.to,
        cc: argv.cc,
        bcc: argv.bcc,
        replyTo: argv.replyTo,
        inReplyTo: argv.inReplyTo,
        references: argv.references,
        messageId: argv.messageId,
        subject: argv.subject,
        body: argv.body,
        attach: argv.attach,
      })

      let r = await gmail(argv.account, argv.verbose).users.messages.send({
        userId: "me",
        requestBody: {
          raw: base64url(raw),
          ...(argv.threadId ? { threadId: argv.threadId } : {}),
        },
      })
      verboseLog(argv.verbose, "send response", { id: r.data.id, threadId: r.data.threadId })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "mark-read <messageId>",
    "Mark a message as read by removing the Gmail UNREAD label",
    y =>
      y.positional("messageId", {
        type: "string",
        describe: "Gmail message id",
      }),
    async argv => {
      let r = await gmail(argv.account, argv.verbose).users.messages.modify({
        userId: "me",
        id: argv.messageId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      })
      verboseLog(argv.verbose, "mark-read message", { id: argv.messageId, labelIds: r.data.labelIds })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "archive <messageId>",
    "Archive a message by removing the Gmail INBOX label",
    y =>
      y.positional("messageId", {
        type: "string",
        describe: "Gmail message id",
      }),
    async argv => {
      let r = await gmail(argv.account, argv.verbose).users.messages.modify({
        userId: "me",
        id: argv.messageId,
        requestBody: {
          removeLabelIds: ["INBOX"],
        },
      })
      verboseLog(argv.verbose, "archive message", { id: argv.messageId, labelIds: r.data.labelIds })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .example("$0 search \"from:alerts@example.com newer_than:7d\"", "Find recent messages")
    .example("$0 search --query \"in:inbox is:unread\" --fetch=metadata", "Search using --query flag with metadata fetch")
    .example("$0 search \"in:inbox\" --format=summary", "Compact summary view with date, from, subject")
    .example("$0 search \"in:inbox\" --fetch=summary --preview-chars=300", "Include decoded body preview in results")
    .example("$0 count \"from:bactolac.com newer_than:1y\"", "Return Gmail's estimated match count for a query")
    .example("$0 thread 190cb53f30f3d1aa", "Fetch all messages in a thread as JSON")
    .example("$0 thread 190cb53f30f3d1aa --format=text", "Read a full conversation in human-readable format")
    .example("$0 export --out-dir=./exports", "Export up to 100 Primary inbox messages into per-message directories")
    .example("$0 export --out-dir=./exports --all", "Export all matched messages by removing the default cap")
    .example("$0 export --out-dir=./exports --resume", "Resume the same export using a default incremental state file")
    .example("$0 corpus --from-export=./exports --out-dir=./corpus", "Build messages.jsonl, chunks.jsonl, and threads.jsonl from exported mail")
    .example("$0 export --out-dir=./exports --scope=inbox --newer-than=7d --has-attachment", "Export recent inbox messages with attachments")
    .example("$0 export --out-dir=./exports --query='from:billing@example.com' --state=./.mailmon/state/export.json", "Export matching messages incrementally using a state file")
    .example("$0 export --out-dir=./exports --jsonl-out=./exports/export.jsonl", "Append one JSONL manifest record per exported or skipped message")
    .example("$0 read 190cf9f55b05efcc", "Read metadata for one Gmail message id")
    .example("$0 read 190cf9f55b05efcc --format=text", "Read a message with decoded headers and body text")
    .example("$0 read 190cf9f55b05efcc --save-attachments=./downloads", "Download attachments from a message")
    .example("$0 mark-read 190cf9f55b05efcc", "Mark one Gmail message as read")
    .example("$0 archive 190cf9f55b05efcc", "Archive one Gmail message (remove INBOX label)")
    .example("$0 send --to user@example.com --subject \"Hi\" --body \"Hello\" --yes", "Send plain-text email")
    .example(
      "$0 send --to user@example.com --cc a@example.com,b@example.com --bcc archive@example.com --subject \"Report\" --attach ./report.pdf --attach ./metrics.csv --yes",
      "Send with multiple recipients and attachments",
    )
    .example(
      "$0 send --to user@example.com --thread-id 190cb53f30f3d1aa --in-reply-to \"<orig@id>\" --references \"<orig@id>\" --body \"Following up\" --yes",
      "Reply in a Gmail thread using thread and message-id headers",
    )
    .epilog(
      [
        "Search notes:",
        "- `search` accepts query as a positional arg or via `--query` flag.",
        "- `--format=summary` shows compact output with date, from, subject, and snippet per message.",
        "- `--fetch=summary` fetches full messages but returns only headers + decoded body preview (truncated to `--preview-chars`).",
        "- Search output always includes `resultSizeEstimate` and `returned` count for pagination decisions.",
        "",
        "Read/thread notes:",
        "- `read --format=text` decodes the message body and prints headers + body as plain text.",
        "- `read --save-attachments=<dir>` downloads all attachments via the Gmail attachments API.",
        "- `thread` fetches all messages in a Gmail thread; use `--format=text` for a human-readable conversation view.",
        "",
        "Export/corpus notes:",
        "- `export` defaults to `in:inbox category:primary` and excludes Spam/Trash unless `--include-spam-trash` is set.",
        `- \`export\` is capped at ${DEFAULT_EXPORT_MAX_MESSAGES} new exports per run by default; use \`--all\` to remove that safety cap or \`--max-messages\` to set your own cap.`,
        "- `export --query` appends raw Gmail search terms to the generated filter query.",
        "- `export --resume` reuses a default state file derived from account, query, and output directory.",
        "- `export --state` sets an explicit state file path for incremental runs.",
        "- `export --jsonl-out` appends per-message manifest records while export is in progress.",
        "- `corpus` consumes exported message folders and writes `messages.jsonl`, `chunks.jsonl`, `threads.jsonl`, and `summary.json`.",
        "",
        "Modify notes:",
        "- `mark-read` removes the `UNREAD` label from the specified message id.",
        "- `archive` removes the `INBOX` label from the specified message id.",
        "- Requires OAuth scope `https://www.googleapis.com/auth/gmail.modify`.",
        "- If your existing token predates this scope, rerun `mailmon auth --account=<name>`.",
        "",
        "Send behavior notes:",
        "- `--yes` is required to send (safety flag).",
        "- `--cc`, `--bcc`, and `--attach` accept repeated flags and comma-separated values.",
        "- `--thread-id` sets Gmail API thread routing.",
        "- `--in-reply-to` and `--references` set RFC 5322 threading headers.",
        "- If `--in-reply-to` is provided, it is normalized and merged into `References`.",
        "- `--verbose` prints resolved credential/token paths and operation diagnostics to stderr.",
      ].join("\n"),
    )
    .demandCommand(1, "Choose a command: search, count, thread, export, corpus, read, mark-read, archive, or send.")
    .strict()
    .recommendCommands()
    .help()

export let parseMailCli = (args: string[], scriptName = "mail") => configureMailCli(yargs(args).scriptName(scriptName)).parseAsync()

export let runMailCli = (args = hideBin(process.argv), scriptName = "mail") =>
  parseMailCli(args, scriptName).catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runMailCli()
}

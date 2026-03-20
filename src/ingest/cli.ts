import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { ingestOnce, watch, buildDefaultStatePath } from "./ingest"
import { createNdjsonSink, createDirSink, createExecSink } from "./sinks"
import type { Sink } from "./sinks"
import { mailSource, markMailRead, fetchMailAttachment } from "../../platforms/mail/MailSource"
import type { MessageSource } from "./ingest"
import type { UnifiedMessage } from "../types"
import { verboseLog } from "../Verbose"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let buildSink = (argv: {
  sink: string
  outDir?: string
  execCmd?: string
  saveAttachments: boolean
  account: string[]
}): Sink => {
  if (argv.sink === "dir") {
    if (!argv.outDir) throw new Error("--out-dir is required when --sink=dir")
    let outDir = path.resolve(argv.outDir)
    // For attachment fetching, we need account context.
    // Use the first account as default — the dir sink writes once per message.
    let defaultAccount = argv.account[0] ?? "default"
    return createDirSink({
      outDir,
      saveAttachments: argv.saveAttachments,
      fetchAttachment: argv.saveAttachments
        ? (msg, filename) => fetchMailAttachment(msg, filename, defaultAccount)
        : undefined,
    })
  }

  if (argv.sink === "exec") {
    if (!argv.execCmd) throw new Error("--exec-cmd is required when --sink=exec")
    return createExecSink({ command: argv.execCmd })
  }

  // ndjson (default)
  return createNdjsonSink({ stream: process.stdout })
}

let resolveSources = (accounts: string[]): Array<{ source: MessageSource; accounts: string[] }> => {
  // Currently only mail is implemented. When other platforms land, this will
  // dispatch based on account naming convention or explicit --platform flag.
  return [{ source: mailSource, accounts }]
}

let sharedOptions = (y: Argv) =>
  y
    .option("account", {
      type: "array",
      string: true,
      default: ["default"],
      coerce: normalizeMultiValue,
      describe: "Account name(s) to ingest from (repeatable, comma-separated)",
    })
    .option("query", {
      type: "string",
      default: "is:unread",
      describe: "Search query (platform-native syntax, e.g. Gmail query)",
    })
    .option("max-results", {
      type: "number",
      default: 100,
      coerce: (value: number) => {
        if (!Number.isFinite(value) || value < 1) throw new Error("--max-results must be positive")
        return Math.floor(value)
      },
      describe: "Maximum messages to ingest per account per cycle",
    })
    .option("sink", {
      type: "string",
      default: "ndjson",
      choices: ["ndjson", "dir", "exec"] as const,
      describe: "Output sink: ndjson (stdout/file), dir (scannable directories), exec (run command per message)",
    })
    .option("out-dir", {
      type: "string",
      describe: "Output directory (required for --sink=dir)",
    })
    .option("exec-cmd", {
      type: "string",
      describe: "Shell command to execute per message (required for --sink=exec)",
    })
    .option("save-attachments", {
      type: "boolean",
      default: false,
      describe: "Download and save attachments (applies to --sink=dir)",
    })
    .option("mark-read", {
      type: "boolean",
      default: false,
      describe: "Mark messages as read after successful ingestion",
    })
    .option("state", {
      type: "string",
      describe: "Path to JSON state file tracking ingested message IDs (auto-derived if omitted)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })

export let configureIngestCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .wrap(null)
    .middleware(argv => sharedOptions(argv as unknown as Argv))
    .command(
      "$0",
      false as unknown as string,
      sharedOptions,
      async argv => {
        let accounts = argv.account as string[]
        let statePath = argv.state
          ? path.resolve(argv.state)
          : buildDefaultStatePath({ accounts, query: argv.query })
        let sink = buildSink({
          sink: argv.sink,
          outDir: argv.outDir,
          execCmd: argv.execCmd,
          saveAttachments: argv.saveAttachments,
          account: accounts,
        })

        verboseLog(argv.verbose, "ingest", {
          accounts,
          query: argv.query,
          sink: argv.sink,
          statePath,
          maxResults: argv.maxResults,
          markRead: argv.markRead,
        })

        let result = await ingestOnce({
          sources: resolveSources(accounts),
          query: argv.query,
          maxResults: argv.maxResults,
          sink,
          statePath,
          markRead: markMailRead,
          doMarkRead: argv.markRead,
          verbose: argv.verbose,
        })

        // Summary to stderr so it doesn't pollute ndjson stdout
        console.error(
          JSON.stringify({
            command: "ingest",
            completedAt: new Date().toISOString(),
            accounts,
            query: argv.query,
            ...result,
          }),
        )
      },
    )
    .example("$0 --account=work --account=personal", "Ingest from multiple accounts, emit NDJSON to stdout")
    .example("$0 --sink=dir --out-dir=./inbox --save-attachments", "Save messages + attachments to scannable directories")
    .example("$0 --sink=exec --exec-cmd='./handle.sh'", "Run a command for each new message")
    .example("$0 --query='is:unread' --mark-read", "Ingest unread messages and mark them read")
    .epilog(
      [
        "Output contract:",
        "- --sink=ndjson: one UnifiedMessage JSON per line to stdout. Summary to stderr.",
        "- --sink=dir: one directory per message under --out-dir with unified.json, body.txt, body.html, attachments/.",
        "- --sink=exec: runs --exec-cmd per message with MESSAGEMON_* env vars and MESSAGEMON_JSON containing the full UnifiedMessage.",
        "",
        "State:",
        "- Maintains a state file tracking ingested message IDs to avoid reprocessing.",
        "- State path is auto-derived from accounts + query, or set explicitly with --state.",
        "- Safe to run from cron — each run picks up only new messages.",
      ].join("\n"),
    )
    .strict()
    .help()

export let configureWatchCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .wrap(null)
    .middleware(argv => sharedOptions(argv as unknown as Argv))
    .command(
      "$0",
      false as unknown as string,
      y =>
        sharedOptions(y).option("interval-ms", {
          type: "number",
          default: 5000,
          coerce: (value: number) => {
            if (!Number.isFinite(value) || value <= 0) throw new Error("--interval-ms must be positive")
            return Math.floor(value)
          },
          describe: "Polling interval in milliseconds between ingest cycles",
        }),
      async argv => {
        let accounts = argv.account as string[]
        let statePath = argv.state
          ? path.resolve(argv.state)
          : buildDefaultStatePath({ accounts, query: argv.query })
        let sink = buildSink({
          sink: argv.sink,
          outDir: argv.outDir,
          execCmd: argv.execCmd,
          saveAttachments: argv.saveAttachments,
          account: accounts,
        })

        verboseLog(argv.verbose, "watch", {
          accounts,
          query: argv.query,
          sink: argv.sink,
          statePath,
          intervalMs: argv.intervalMs,
          maxResults: argv.maxResults,
          markRead: argv.markRead,
        })

        console.error(`[messagemon] watching ${accounts.join(", ")} — query: ${argv.query} — interval: ${argv.intervalMs}ms`)

        await watch({
          sources: resolveSources(accounts),
          query: argv.query,
          maxResults: argv.maxResults,
          sink,
          statePath,
          markRead: markMailRead,
          doMarkRead: argv.markRead,
          verbose: argv.verbose,
          intervalMs: argv.intervalMs,
        })
      },
    )
    .example("$0 --account=work --account=personal", "Watch multiple accounts, stream NDJSON to stdout")
    .example("$0 --sink=dir --out-dir=./inbox --save-attachments --interval-ms=10000", "Save new messages to disk every 10s")
    .example("$0 --sink=exec --exec-cmd='./agent.sh' --mark-read", "Run an agent for each new message, then mark read")
    .example("$0 | my-router-tool", "Pipe NDJSON stream to another process")
    .epilog(
      [
        "Behavior:",
        "- Runs continuously, polling at --interval-ms between cycles.",
        "- Each cycle calls ingest: scans all accounts, emits new messages to sink.",
        "- Same state tracking as `ingest` — safe to restart without reprocessing.",
        "- Kill with SIGTERM/SIGINT to stop.",
        "",
        "Daemon usage:",
        "  messagemon watch --account=work --sink=ndjson | my-agent-router",
        "  messagemon watch --sink=dir --out-dir=/data/inbox --save-attachments &",
      ].join("\n"),
    )
    .strict()
    .help()

export let parseIngestCli = (args: string[], scriptName = "messagemon ingest") =>
  configureIngestCli(yargs(args).scriptName(scriptName)).parseAsync()

export let parseWatchCli = (args: string[], scriptName = "messagemon watch") =>
  configureWatchCli(yargs(args).scriptName(scriptName)).parseAsync()

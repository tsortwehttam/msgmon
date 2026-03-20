import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { parseAccountsCli } from "../platforms/gmail/accounts"
import { parseAuthCli } from "../platforms/gmail/auth"
import { parseGmailCli } from "../platforms/gmail/mail"
import { parseCorpusCli } from "../src/corpus/cli"
import { parseIngestCli, parseWatchCli } from "../src/ingest/cli"
import { parseSlackCli } from "../platforms/slack"
import { parseTeamsCli } from "../platforms/teams"
import { parseWhatsAppCli } from "../platforms/whatsapp"
import { parseServeCli } from "../src/serve/cli"
import { parseDraftCli } from "../src/draft/cli"
import { parseWorkspaceCli } from "../src/workspace/cli"
import { parseSessionCli, parseSyncCli } from "../src/session/cli"
import { parseSetupCli } from "../src/setup/cli"
import { verboseLog } from "../src/Verbose"

let args = hideBin(process.argv)
let subcommands = new Set(["gmail", "slack", "teams", "whatsapp", "ingest", "watch", "corpus", "serve", "draft", "workspace", "sync", "session", "setup", "help"])
let verbose = args.includes("--verbose") || args.includes("-v")
let commandIndex = args.findIndex(x => !x.startsWith("-"))
let command = commandIndex >= 0 ? args[commandIndex] : undefined
let commandArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
let forwardedVerboseArgs = verbose ? ["--verbose"] : []
let dispatched = false
let helpBuilder = (y: import("yargs").Argv) =>
  y
    .positional("platform", {
      type: "string",
      choices: ["gmail", "slack", "teams", "whatsapp", "ingest", "watch", "corpus", "serve", "draft", "workspace", "sync", "session", "setup"] as const,
      describe: "Platform or command to show help for",
    })
    .positional("command", {
      type: "string",
      describe: "Subcommand to show help for",
    })

let cli = yargs(args)
  .scriptName("msgmon")
  .usage("Usage: $0 <command> [options]")
  .option("verbose", {
    alias: "v",
    type: "boolean",
    default: false,
    describe: "Print diagnostic details to stderr",
  })
  .command("gmail", "Gmail: search, read, send, export, thread, count, mark-read, archive")
  .command("ingest", "One-shot: ingest new messages across accounts, emit to sink, then exit (cron-friendly)")
  .command("watch", "Daemon: continuously ingest new messages across accounts, emit to sink as they arrive")
  .command("corpus", "Build LLM-oriented corpus (messages.jsonl, chunks.jsonl, threads.jsonl) from ingested messages")
  .command("setup", "Interactive guided setup: credentials, auth, workspace, and seed in one flow")
  .command("serve", "HTTP API server: secret-holding control plane with policy-gated workspace sync")
  .command("draft", "Compose, list, send, edit, and delete message drafts")
  .command("workspace", "Create and refresh server-managed agent workspaces")
  .command("sync", "Sync an agent-safe local workspace mirror against serve")
  .command("session", "Bootstrap and supervise a local agent session against serve")
  .command("slack", "Slack: auth, search, read, send messages")
  .command("teams", "Teams: search, read, send messages (planned)")
  .command("whatsapp", "WhatsApp: read, send messages (planned)")
  .command(
    "help [platform] [command]",
    "Show main help or help for a specific platform/command",
    helpBuilder as never,
    async argv => {
      let platform = argv.platform as string | undefined
      let subcommand = argv.command as string | undefined
      if (!platform) {
        cli.showHelp()
        return
      }
      let helpArgs: string[] = subcommand ? [subcommand, "--help"] : ["--help"]
      if (platform === "gmail") await parseGmailCli(helpArgs, "msgmon gmail")
      else if (platform === "ingest") await parseIngestCli(helpArgs, "msgmon ingest")
      else if (platform === "watch") await parseWatchCli(helpArgs, "msgmon watch")
      else if (platform === "corpus") await parseCorpusCli(helpArgs, "msgmon corpus")
      else if (platform === "serve") await parseServeCli(helpArgs, "msgmon serve")
      else if (platform === "slack") await parseSlackCli(helpArgs, "msgmon slack")
      else if (platform === "teams") await parseTeamsCli(helpArgs, "msgmon teams")
      else if (platform === "whatsapp") await parseWhatsAppCli(helpArgs, "msgmon whatsapp")
      else if (platform === "draft") await parseDraftCli(helpArgs, "msgmon draft")
      else if (platform === "workspace") await parseWorkspaceCli(helpArgs, "msgmon workspace")
      else if (platform === "sync") await parseSyncCli(helpArgs, "msgmon sync")
      else if (platform === "session") await parseSessionCli(helpArgs, "msgmon session")
    },
  )
  .example("$0 help", "Show top-level help")
  .example("$0 help mail", "Show help for mail subcommands and options")
  .example("$0 mail search \"from:someone newer_than:7d\"", "Search Gmail messages")
  .example("$0 mail send --to you@example.com --subject \"Hi\" --body \"Hello\" --yes", "Send an email")
  .example("$0 mail auth --account=personal", "Authorize a Gmail account")
  .example("$0 ingest --account=work --account=personal --sink=dir --out-dir=./inbox", "One-shot ingest to disk")
  .example("$0 ingest --sink=ndjson > today.jsonl", "Dump new messages as NDJSON")
  .example("$0 watch --account=work --sink=ndjson | my-router", "Stream messages to another process")
  .example("$0 watch --sink=dir --out-dir=/data/inbox --save-attachments", "Daemon: save to disk as messages arrive")
  .example("$0 watch --sink=exec --exec-cmd='./agent.sh' --mark-read", "Run agent per message")
  .example("$0 corpus --from=./inbox --out-dir=./corpus", "Build LLM corpus from ingested messages")
  .epilog(
    [
      "Commands:",
      "  gmail     — Gmail operations: search, read, send, export, etc.",
      "  ingest    — One-shot multi-account ingest. Cron-friendly. Emits UnifiedMessage.",
      "  watch     — Continuous multi-account daemon. Emits UnifiedMessage as they arrive.",
      "  corpus    — Build LLM corpus from ingested message directories.",
      "  setup     — Interactive guided setup: credentials, auth, workspace, and seed.",
      "  serve     — Secret-holding HTTP control plane with policy-gated workspace sync.",
      "  draft     — Compose, list, send, edit, and delete message drafts.",
      "  workspace — Create and refresh server-managed agent workspaces.",
      "  sync      — Pull, push, and watch a local agent workspace mirror.",
      "  session   — Bootstrap a local agent session and optional watcher.",
      "",
      "Platforms:",
      "  slack     — Slack via @slack/web-api",
      "  teams     — Microsoft Teams via Graph API (planned)",
      "  whatsapp  — WhatsApp via Cloud API (planned)",
      "",
      "Sinks (for ingest/watch):",
      "  ndjson    — One JSON line per message to stdout (pipe-friendly)",
      "  dir       — Scannable directory per message (unified.json, body.txt, attachments/)",
      "  exec      — Run a shell command per message with MSGMON_* env vars",
      "",
      "Each platform stores credentials and tokens under .msgmon/<platform>/.",
      "Use `msgmon gmail auth` to set up Gmail credentials.",
      "Use `--verbose` at any level for stderr diagnostics.",
    ].join("\n"),
  )
  .strict()
  .demandCommand(1)
  .recommendCommands()
  .help()
  .alias("help", "h")

if (args.length === 0) {
  cli.showHelp()
  process.exit(0)
}

if (verbose) {
  verboseLog(true, "dispatch args", { args })
}

if (args.includes("--help") || args.includes("-h")) {
  if (!command) {
    cli.showHelp()
    process.exit(0)
  }
}

if (command == null) {
  if (args.includes("--version")) {
    dispatched = true
    cli.parseAsync().catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  } else {
    cli.showHelp()
    process.exit(0)
  }
}

if (!dispatched && (args[0] === "--help" || args[0] === "-h")) {
  cli.showHelp()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Gmail platform — dispatches to sub-parsers for gmail-specific commands
// ---------------------------------------------------------------------------

if (!dispatched && command === "gmail") {
  let gmailSubcommand = commandArgs.find(x => !x.startsWith("-"))

  if (gmailSubcommand === "auth") {
    let authArgs = commandArgs.filter(x => x !== "auth")
    parseAuthCli([...forwardedVerboseArgs, ...authArgs], "msgmon gmail auth").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  } else if (gmailSubcommand === "accounts") {
    let accountsArgs = commandArgs.filter(x => x !== "accounts")
    parseAccountsCli([...forwardedVerboseArgs, ...accountsArgs], "msgmon gmail accounts").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  } else {
    parseGmailCli([...forwardedVerboseArgs, ...commandArgs], "msgmon gmail").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
}

// ---------------------------------------------------------------------------
// Ingest — one-shot multi-account ingest
// ---------------------------------------------------------------------------

else if (!dispatched && command === "ingest") {
  parseIngestCli([...forwardedVerboseArgs, ...commandArgs], "msgmon ingest").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Watch — continuous multi-account daemon
// ---------------------------------------------------------------------------

else if (!dispatched && command === "watch") {
  parseWatchCli([...forwardedVerboseArgs, ...commandArgs], "msgmon watch").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Corpus — build LLM corpus from ingested message directories
// ---------------------------------------------------------------------------

else if (!dispatched && command === "corpus") {
  parseCorpusCli([...forwardedVerboseArgs, ...commandArgs], "msgmon corpus").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Serve — HTTP API server
// ---------------------------------------------------------------------------

else if (!dispatched && command === "serve") {
  parseServeCli([...forwardedVerboseArgs, ...commandArgs], "msgmon serve").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Slack platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "slack") {
  parseSlackCli([...forwardedVerboseArgs, ...commandArgs], "msgmon slack").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Teams platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "teams") {
  parseTeamsCli([...forwardedVerboseArgs, ...commandArgs], "msgmon teams").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// WhatsApp platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "whatsapp") {
  parseWhatsAppCli([...forwardedVerboseArgs, ...commandArgs], "msgmon whatsapp").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Draft — compose, list, send, edit, delete message drafts
// ---------------------------------------------------------------------------

else if (!dispatched && command === "draft") {
  parseDraftCli([...forwardedVerboseArgs, ...commandArgs], "msgmon draft").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Workspace — create and manage agent workspaces
// ---------------------------------------------------------------------------

else if (!dispatched && command === "workspace") {
  parseWorkspaceCli([...forwardedVerboseArgs, ...commandArgs], "msgmon workspace").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Sync — pull/push/watch local agent workspace mirrors
// ---------------------------------------------------------------------------

else if (!dispatched && command === "sync") {
  parseSyncCli([...forwardedVerboseArgs, ...commandArgs], "msgmon sync").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Setup — interactive guided setup
// ---------------------------------------------------------------------------

else if (!dispatched && command === "setup") {
  parseSetupCli([...forwardedVerboseArgs, ...commandArgs], "msgmon setup").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Session — bootstrap and supervise local agent sessions
// ---------------------------------------------------------------------------

else if (!dispatched && command === "session") {
  parseSessionCli([...forwardedVerboseArgs, ...commandArgs], "msgmon session").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

else if (!dispatched && command === "help") {
  if (args.length === 1) {
    cli.showHelp()
    process.exit(0)
  }
  let subhelp = commandArgs[0]
  if (subhelp === "gmail") {
    parseGmailCli([...forwardedVerboseArgs, "--help"], "msgmon gmail")
  } else if (subhelp === "ingest") {
    parseIngestCli([...forwardedVerboseArgs, "--help"], "msgmon ingest")
  } else if (subhelp === "watch") {
    parseWatchCli([...forwardedVerboseArgs, "--help"], "msgmon watch")
  } else if (subhelp === "corpus") {
    parseCorpusCli([...forwardedVerboseArgs, "--help"], "msgmon corpus")
  } else if (subhelp === "serve") {
    parseServeCli([...forwardedVerboseArgs, "--help"], "msgmon serve")
  } else if (subhelp === "slack") {
    parseSlackCli([...forwardedVerboseArgs, "--help"], "msgmon slack")
  } else if (subhelp === "teams") {
    parseTeamsCli([...forwardedVerboseArgs, "--help"], "msgmon teams")
  } else if (subhelp === "whatsapp") {
    parseWhatsAppCli([...forwardedVerboseArgs, "--help"], "msgmon whatsapp")
  } else if (subhelp === "draft") {
    parseDraftCli([...forwardedVerboseArgs, "--help"], "msgmon draft")
  } else if (subhelp === "workspace") {
    parseWorkspaceCli([...forwardedVerboseArgs, "--help"], "msgmon workspace")
  } else if (subhelp === "sync") {
    parseSyncCli([...forwardedVerboseArgs, "--help"], "msgmon sync")
  } else if (subhelp === "session") {
    parseSessionCli([...forwardedVerboseArgs, "--help"], "msgmon session")
  } else if (subhelp === "setup") {
    parseSetupCli([...forwardedVerboseArgs, "--help"], "msgmon setup")
  } else {
    cli.parseAsync().catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
}

// ---------------------------------------------------------------------------
// Unknown command — let yargs handle the error
// ---------------------------------------------------------------------------

else if (!dispatched) {
  if (!command || !subcommands.has(command)) {
    cli.parseAsync().catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
}

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
import { verboseLog } from "../src/Verbose"

let args = hideBin(process.argv)
let subcommands = new Set(["gmail", "slack", "teams", "whatsapp", "ingest", "watch", "corpus", "serve", "draft", "workspace", "help"])
let verbose = args.includes("--verbose") || args.includes("-v")
let commandIndex = args.findIndex(x => !x.startsWith("-"))
let command = commandIndex >= 0 ? args[commandIndex] : undefined
let commandArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
let forwardedVerboseArgs = verbose ? ["--verbose"] : []
let dispatched = false

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
  .command("serve", "HTTP API server: proxies all commands with token auth")
  .command("draft", "Compose, list, send, edit, and delete message drafts")
  .command("workspace", "Create and manage agent workspaces for message monitoring")
  .command("slack", "Slack: auth, search, read, send messages")
  .command("teams", "Teams: search, read, send messages (planned)")
  .command("whatsapp", "WhatsApp: read, send messages (planned)")
  .command(
    "help [platform] [command]",
    "Show main help or help for a specific platform/command",
    y =>
      y
        .positional("platform", {
          type: "string",
          choices: ["gmail", "slack", "teams", "whatsapp", "ingest", "watch", "corpus", "serve", "draft", "workspace"] as const,
          describe: "Platform or command to show help for",
        })
        .positional("command", {
          type: "string",
          describe: "Subcommand to show help for",
        }),
    async argv => {
      if (!argv.platform) {
        cli.showHelp()
        return
      }
      let helpArgs = argv.command ? [argv.command, "--help"] : ["--help"]
      if (argv.platform === "gmail") return parseGmailCli(helpArgs, "msgmon gmail")
      if (argv.platform === "ingest") return parseIngestCli(helpArgs, "msgmon ingest")
      if (argv.platform === "watch") return parseWatchCli(helpArgs, "msgmon watch")
      if (argv.platform === "corpus") return parseCorpusCli(helpArgs, "msgmon corpus")
      if (argv.platform === "serve") return parseServeCli(helpArgs, "msgmon serve")
      if (argv.platform === "slack") return parseSlackCli(helpArgs, "msgmon slack")
      if (argv.platform === "teams") return parseTeamsCli(helpArgs, "msgmon teams")
      if (argv.platform === "whatsapp") return parseWhatsAppCli(helpArgs, "msgmon whatsapp")
      if (argv.platform === "draft") return parseDraftCli(helpArgs, "msgmon draft")
      if (argv.platform === "workspace") return parseWorkspaceCli(helpArgs, "msgmon workspace")
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
      "  serve     — HTTP API server with token auth (proxies all commands).",
      "  draft     — Compose, list, send, edit, and delete message drafts.",
      "  workspace — Create and manage agent workspaces for message monitoring.",
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

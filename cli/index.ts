import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { parseAccountsCli } from "../platforms/mail/accounts"
import { parseAuthCli } from "../platforms/mail/auth"
import { parseMailCli } from "../platforms/mail/mail"
import { parseIngestCli, parseWatchCli } from "../src/ingest/cli"
import { parseSlackCli } from "../platforms/slack"
import { parseTeamsCli } from "../platforms/teams"
import { parseWhatsAppCli } from "../platforms/whatsapp"
import { verboseLog } from "../src/Verbose"

let args = hideBin(process.argv)
let subcommands = new Set(["mail", "slack", "teams", "whatsapp", "ingest", "watch", "help"])
let verbose = args.includes("--verbose") || args.includes("-v")
let commandIndex = args.findIndex(x => !x.startsWith("-"))
let command = commandIndex >= 0 ? args[commandIndex] : undefined
let commandArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
let forwardedVerboseArgs = verbose ? ["--verbose"] : []
let dispatched = false

let cli = yargs(args)
  .scriptName("messagemon")
  .usage("Usage: $0 <command> [options]")
  .option("verbose", {
    alias: "v",
    type: "boolean",
    default: false,
    describe: "Print diagnostic details to stderr",
  })
  .command("mail", "Gmail: search, read, send, export, corpus, thread, count, mark-read, archive")
  .command("ingest", "One-shot: ingest new messages across accounts, emit to sink, then exit (cron-friendly)")
  .command("watch", "Daemon: continuously ingest new messages across accounts, emit to sink as they arrive")
  .command("slack", "Slack: search, read, send messages (planned)")
  .command("teams", "Teams: search, read, send messages (planned)")
  .command("whatsapp", "WhatsApp: read, send messages (planned)")
  .command(
    "help [platform] [command]",
    "Show main help or help for a specific platform/command",
    y =>
      y
        .positional("platform", {
          type: "string",
          choices: ["mail", "slack", "teams", "whatsapp", "ingest", "watch"] as const,
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
      if (argv.platform === "mail") return parseMailCli(helpArgs, "messagemon mail")
      if (argv.platform === "ingest") return parseIngestCli(helpArgs, "messagemon ingest")
      if (argv.platform === "watch") return parseWatchCli(helpArgs, "messagemon watch")
      if (argv.platform === "slack") return parseSlackCli(helpArgs, "messagemon slack")
      if (argv.platform === "teams") return parseTeamsCli(helpArgs, "messagemon teams")
      if (argv.platform === "whatsapp") return parseWhatsAppCli(helpArgs, "messagemon whatsapp")
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
  .epilog(
    [
      "Commands:",
      "  mail      — Gmail operations: search, read, send, export, corpus, etc.",
      "  ingest    — One-shot multi-account ingest. Cron-friendly. Emits UnifiedMessage.",
      "  watch     — Continuous multi-account daemon. Emits UnifiedMessage as they arrive.",
      "",
      "Platforms (planned):",
      "  slack     — Slack via @slack/web-api",
      "  teams     — Microsoft Teams via Graph API",
      "  whatsapp  — WhatsApp via Cloud API",
      "",
      "Sinks (for ingest/watch):",
      "  ndjson    — One JSON line per message to stdout (pipe-friendly)",
      "  dir       — Scannable directory per message (unified.json, body.txt, attachments/)",
      "  exec      — Run a shell command per message with MESSAGEMON_* env vars",
      "",
      "Each platform stores credentials and tokens under .messagemon/<platform>/.",
      "Use `messagemon mail auth` to set up Gmail credentials.",
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
// Mail platform — dispatches to sub-parsers for mail-specific commands
// ---------------------------------------------------------------------------

if (!dispatched && command === "mail") {
  let mailSubcommand = commandArgs.find(x => !x.startsWith("-"))

  if (mailSubcommand === "auth") {
    let authArgs = commandArgs.filter(x => x !== "auth")
    parseAuthCli([...forwardedVerboseArgs, ...authArgs], "messagemon mail auth").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  } else if (mailSubcommand === "accounts") {
    let accountsArgs = commandArgs.filter(x => x !== "accounts")
    parseAccountsCli([...forwardedVerboseArgs, ...accountsArgs], "messagemon mail accounts").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  } else {
    parseMailCli([...forwardedVerboseArgs, ...commandArgs], "messagemon mail").catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
}

// ---------------------------------------------------------------------------
// Ingest — one-shot multi-account ingest
// ---------------------------------------------------------------------------

else if (!dispatched && command === "ingest") {
  parseIngestCli([...forwardedVerboseArgs, ...commandArgs], "messagemon ingest").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Watch — continuous multi-account daemon
// ---------------------------------------------------------------------------

else if (!dispatched && command === "watch") {
  parseWatchCli([...forwardedVerboseArgs, ...commandArgs], "messagemon watch").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Slack platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "slack") {
  parseSlackCli([...forwardedVerboseArgs, ...commandArgs], "messagemon slack").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Teams platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "teams") {
  parseTeamsCli([...forwardedVerboseArgs, ...commandArgs], "messagemon teams").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// WhatsApp platform
// ---------------------------------------------------------------------------

else if (!dispatched && command === "whatsapp") {
  parseWhatsAppCli([...forwardedVerboseArgs, ...commandArgs], "messagemon whatsapp").catch(e => {
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
  if (subhelp === "mail") {
    parseMailCli([...forwardedVerboseArgs, "--help"], "messagemon mail")
  } else if (subhelp === "ingest") {
    parseIngestCli([...forwardedVerboseArgs, "--help"], "messagemon ingest")
  } else if (subhelp === "watch") {
    parseWatchCli([...forwardedVerboseArgs, "--help"], "messagemon watch")
  } else if (subhelp === "slack") {
    parseSlackCli([...forwardedVerboseArgs, "--help"], "messagemon slack")
  } else if (subhelp === "teams") {
    parseTeamsCli([...forwardedVerboseArgs, "--help"], "messagemon teams")
  } else if (subhelp === "whatsapp") {
    parseWhatsAppCli([...forwardedVerboseArgs, "--help"], "messagemon whatsapp")
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

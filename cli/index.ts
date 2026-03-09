import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { parseAccountsCli } from "./accounts"
import { parseAuthCli } from "./auth"
import { parseMailCli } from "./mail"
import { parseMonitorCli } from "./monitor"
import { parsePollCli } from "./poll"
import { verboseLog } from "../src/Verbose"

let args = hideBin(process.argv)
let subcommands = new Set(["mail", "auth", "accounts", "poll", "monitor"])
let verbose = args.includes("--verbose") || args.includes("-v")
let commandIndex = args.findIndex(x => !x.startsWith("-"))
let command = commandIndex >= 0 ? args[commandIndex] : undefined
let commandArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
let forwardedVerboseArgs = verbose ? ["--verbose"] : []
let dispatched = false

let cli = yargs(args)
  .scriptName("mailmon")
  .usage("Usage: $0 <command> [subcommand/options]")
  .option("verbose", {
    alias: "v",
    type: "boolean",
    default: false,
    describe: "Print diagnostic details to stderr",
  })
  .command("mail", "Search, read, and send Gmail messages")
  .command("auth", "Run OAuth flow and store/update token for an account")
  .command("accounts", "List token-backed accounts available to this CLI")
  .command("poll", "Poll for Gmail query matches and emit JSON when found")
  .command("monitor", "Monitor Gmail query matches and run an agent command for each new message")
  .command(
    "help [command]",
    "Show main help or help for a specific subcommand",
    y =>
      y.positional("command", {
        type: "string",
        choices: ["mail", "auth", "accounts", "poll", "monitor"] as const,
        describe: "Subcommand to show help for",
      }),
    async argv => {
      if (!argv.command) {
        cli.showHelp()
        return
      }
      if (argv.command === "mail") return parseMailCli(["--help"], "mailmon mail")
      if (argv.command === "auth") return parseAuthCli(["--help"], "mailmon auth")
      if (argv.command === "poll") return parsePollCli(["--help"], "mailmon poll")
      if (argv.command === "monitor") return parseMonitorCli(["--help"], "mailmon monitor")
      return parseAccountsCli(["--help"], "mailmon accounts")
    },
  )
  .example("$0 help", "Show top-level help")
  .example("$0 help mail", "Show help for mail subcommands and options")
  .example("$0 mail --help", "Show mail subcommands and full send options")
  .example("$0 mail send --help", "Show all send headers/threading/attachment flags")
  .example("$0 mail search \"from:someone newer_than:7d\"", "Search messages")
  .example("$0 mail read 190cf9f55b05efcc", "Read message metadata by Gmail message id")
  .example("$0 mail mark-read 190cf9f55b05efcc", "Mark a Gmail message as read")
  .example("$0 mail archive 190cf9f55b05efcc", "Archive a Gmail message")
  .example("$0 mail send --to you@example.com --subject \"Hi\" --body \"Hello\" --yes", "Send a basic email")
  .example(
    "$0 mail send --to you@example.com --thread-id 190cb53f30f3d1aa --in-reply-to \"<orig@id>\" --references \"<orig@id>\" --body \"Reply\" --yes",
    "Reply in a thread with explicit headers",
  )
  .example("$0 auth --account=personal", "Authorize and store a token for an account")
  .example("$0 accounts --format=json", "List accounts in machine-readable form")
  .example(
    "$0 poll --account=personal --query='category:promotions is:unread' --interval-ms=2000",
    "Poll for query matches and emit JSON once found",
  )
  .example(
    "$0 monitor --account=personal --query='in:inbox is:unread' --agent-cmd='codex run \"Read TASK.md and process.\"'",
    "Monitor and invoke an agent command per new matched message",
  )
  .epilog(
    [
      "Automation notes:",
      "- `mail` outputs JSON.",
      "- `accounts` outputs JSON by default (`--format=text` for line output).",
      "- `poll` outputs JSON once query matches exist, then exits.",
      "- `monitor` runs continuously and invokes `--agent-cmd` for each newly seen message id.",
      "- `auth` prints a success line with the saved token path.",
      "- `--verbose` can be used at top-level or subcommand level for stderr diagnostics.",
      "- Use `mail --help` and `mail send --help` for full option/behavior contracts.",
      "- Account selection is always via `--account` (default: \"default\").",
      "- `help <command>` is supported for: mail, auth, accounts, poll, monitor.",
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

if (!dispatched && command === "mail") {
  parseMailCli([...forwardedVerboseArgs, ...commandArgs], "mailmon mail").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
} else if (!dispatched && command === "auth") {
  parseAuthCli([...forwardedVerboseArgs, ...commandArgs], "mailmon auth").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
} else if (!dispatched && command === "accounts") {
  parseAccountsCli([...forwardedVerboseArgs, ...commandArgs], "mailmon accounts").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
} else if (!dispatched && command === "poll") {
  parsePollCli([...forwardedVerboseArgs, ...commandArgs], "mailmon poll").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
} else if (!dispatched && command === "monitor") {
  parseMonitorCli([...forwardedVerboseArgs, ...commandArgs], "mailmon monitor").catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
} else if (!dispatched && command === "help") {
  if (args.length === 1) {
    cli.showHelp()
    process.exit(0)
  }
  let subhelp = commandArgs[0]
  if (subhelp === "mail") {
    parseMailCli([...forwardedVerboseArgs, "--help"], "mailmon mail")
  } else if (subhelp === "auth") {
    parseAuthCli([...forwardedVerboseArgs, "--help"], "mailmon auth")
  } else if (subhelp === "poll") {
    parsePollCli([...forwardedVerboseArgs, "--help"], "mailmon poll")
  } else if (subhelp === "monitor") {
    parseMonitorCli([...forwardedVerboseArgs, "--help"], "mailmon monitor")
  } else if (subhelp === "accounts") {
    parseAccountsCli([...forwardedVerboseArgs, "--help"], "mailmon accounts")
  } else {
    cli.parseAsync().catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
} else if (!dispatched) {
  if (!command || !subcommands.has(command)) {
    cli.parseAsync().catch(e => {
      console.error(e?.message ?? e)
      process.exit(1)
    })
  }
}

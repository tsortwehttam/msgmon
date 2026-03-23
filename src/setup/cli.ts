import yargs from "yargs"
import type { Argv } from "yargs"
import path from "node:path"
import fs from "node:fs"
import { setWorkspaceDir } from "../CliConfig"
import { runSetup } from "./index"

export let configureSetupCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [dir] [options]")
    .command("$0 [dir]", false, y =>
      y
        .positional("dir", {
          type: "string",
          describe: "Server workspace directory to initialize (defaults to current directory)",
        })
        .option("workspace", {
          type: "string",
          default: "default",
          hidden: true,
          describe: "Internal server workspace id to create/verify",
        })
        .option("since", {
          type: "string",
          describe: "Lower time bound for the initial pull as ISO timestamp or YYYY-MM-DD",
        })
        .option("until", {
          type: "string",
          describe: "Upper time bound for the initial pull as ISO timestamp or YYYY-MM-DD",
        })
        .option("yes", {
          alias: "y",
          type: "boolean",
          default: false,
          describe: "Auto-confirm all prompts for non-interactive use",
        })
        .option("gmail-accounts", {
          type: "string",
          describe: "Gmail accounts to use: \"all\" for existing tokens, or comma-separated emails",
        })
        .option("slack-accounts", {
          type: "string",
          describe: "Slack accounts to set up: \"all\" for existing tokens, or comma-separated names",
        })
        .option("slack-token", {
          type: "string",
          describe: "Slack bot token to save (single account only)",
        })
        .option("slack-mode", {
          type: "string",
          choices: ["bot", "oauth"],
          default: "bot",
          describe: "Slack auth mode",
        })
        .option("slack-channels", {
          type: "string",
          describe: "Slack channels to monitor: \"all\", or per-account like \"work:#general,work:#eng,personal:#projects\", or bare \"#general,#eng\" for all accounts",
        }))
    .example("$0", "Interactive guided setup in the current directory")
    .example("$0 ./workspace --since=2026-03-15", "Set up with an explicit initial lower time bound")
    .example("$0 -y --gmail-accounts=all", "Non-interactive setup using existing tokens")
    .epilog(
      [
        "Walks through the full setup process interactively:",
        "  1. Check/create Gmail OAuth credentials",
        "  2. Authorize Gmail account(s) via browser OAuth",
        "  3. Optionally set up Slack",
        "  4. Create a server workspace",
        "  5. Pull the initial message window into messages.jsonl",
        "  6. Print the commands to start the server and agent",
        "",
        "Safe to re-run — skips steps that are already done.",
        "Pass -y with account flags for fully non-interactive operation.",
      ].join("\n"),
    )
    .demandCommand(0)
    .strict()
    .help()

export let parseSetupCli = async (args: string[], scriptName = "msgmon setup") => {
  let argv = await configureSetupCli(yargs(args).scriptName(scriptName)).parseAsync()
  let dir = path.resolve((argv.dir as string | undefined) ?? ".")
  fs.mkdirSync(dir, { recursive: true })
  setWorkspaceDir(dir)
  await runSetup({
    workspace: argv.workspace as string | undefined,
    since: argv.since as string | undefined,
    until: argv.until as string | undefined,
    yes: argv.yes as boolean,
    gmailAccounts: argv.gmailAccounts as string | undefined,
    slackAccounts: argv.slackAccounts as string | undefined,
    slackToken: argv.slackToken as string | undefined,
    slackMode: argv.slackMode as string | undefined,
    slackChannels: argv.slackChannels as string | undefined,
  })
}

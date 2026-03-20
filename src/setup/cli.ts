import yargs from "yargs"
import type { Argv } from "yargs"
import { runSetup } from "./index"

export let configureSetupCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .option("workspace", {
      type: "string",
      default: "default",
      describe: "Workspace id to create/verify",
    })
    .example("$0", "Interactive guided setup")
    .example("$0 --workspace=inbox", "Set up with workspace named 'inbox'")
    .epilog(
      [
        "Walks through the full setup process interactively:",
        "  1. Check/create Gmail OAuth credentials",
        "  2. Authorize Gmail account(s) via browser OAuth",
        "  3. Optionally set up Slack",
        "  4. Create a workspace",
        "  5. Seed the workspace with current message IDs",
        "  6. Print the commands to start the server and agent",
        "",
        "Safe to re-run — skips steps that are already done.",
      ].join("\n"),
    )
    .strict()
    .help()

export let parseSetupCli = async (args: string[], scriptName = "msgmon setup") => {
  let argv = await configureSetupCli(yargs(args).scriptName(scriptName)).parseAsync()
  await runSetup({ workspace: argv.workspace })
}

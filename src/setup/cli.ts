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
          describe: "Workspace directory to initialize (defaults to current directory)",
        })
        .option("workspace", {
          type: "string",
          default: "default",
          hidden: true,
          describe: "Internal workspace id to create/verify",
        }))
    .example("$0", "Interactive guided setup in the current directory")
    .example("$0 ./assistant-workspace", "Create the directory if needed and set it up as a workspace")
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
    .demandCommand(0)
    .strict()
    .help()

export let parseSetupCli = async (args: string[], scriptName = "msgmon setup") => {
  let argv = await configureSetupCli(yargs(args).scriptName(scriptName)).parseAsync()
  let dir = path.resolve((argv.dir as string | undefined) ?? ".")
  fs.mkdirSync(dir, { recursive: true })
  setWorkspaceDir(dir)
  await runSetup({ workspace: argv.workspace as string | undefined })
}

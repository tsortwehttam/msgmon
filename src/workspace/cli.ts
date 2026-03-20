import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { initWorkspace, loadWorkspaceConfig } from "./init"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

export let configureWorkspaceCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .command(
      "init <path>",
      "Create a new workspace directory with default files",
      y =>
        y
          .positional("path", {
            type: "string",
            demandOption: true,
            describe: "Directory to create the workspace in",
          })
          .option("name", {
            type: "string",
            describe: "Workspace name (defaults to directory name)",
          })
          .option("account", {
            type: "array",
            string: true,
            default: ["default"],
            coerce: normalizeMultiValue,
            describe: "Account(s) to configure (repeatable, comma-separated)",
          })
          .option("query", {
            type: "string",
            default: "is:unread",
            describe: "Default ingest query",
          }),
      async argv => {
        let result = initWorkspace(argv.path!, {
          name: argv.name,
          accounts: argv.account,
          query: argv.query,
        })

        console.log(JSON.stringify({
          created: true,
          path: result.path,
          config: result.config,
          files: [
            "workspace.json",
            "instructions.md",
            "user-profile.md",
            "status.md",
            "inbox/",
            "drafts/",
            "corpus/",
          ],
        }, null, 2))

        console.error(`\nWorkspace created at ${result.path}`)
        console.error(`\nNext steps:`)
        console.error(`  1. Edit ${path.join(result.path, "user-profile.md")} with your info`)
        console.error(`  2. Edit ${path.join(result.path, "instructions.md")} to customize agent behavior`)
        console.error(`  3. Seed historical messages:`)
        console.error(`     msgmon ingest --seed --query='newer_than:30d' --sink=dir --out-dir=${path.join(result.path, "inbox")}`)
        console.error(`  4. Start watching:`)
        console.error(`     msgmon watch --sink=dir --out-dir=${path.join(result.path, "inbox")} --account=${result.config.accounts.join(",")}`)
      },
    )
    .command(
      "show [path]",
      "Show workspace configuration",
      y =>
        y.positional("path", {
          type: "string",
          default: ".",
          describe: "Workspace directory (default: current directory)",
        }),
      async argv => {
        let config = loadWorkspaceConfig(argv.path!)
        console.log(JSON.stringify(config, null, 2))
      },
    )
    .demandCommand(1, "Choose a command: init or show.")
    .strict()
    .help()

export let parseWorkspaceCli = (args: string[], scriptName = "msgmon workspace") =>
  configureWorkspaceCli(yargs(args).scriptName(scriptName)).parseAsync()

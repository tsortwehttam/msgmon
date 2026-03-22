import fs from "node:fs"
import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { setWorkspaceDir } from "../CliConfig"
import { DEFAULT_WORKSPACE_ID } from "../defaults"
import { inferWorkspaceAccounts } from "./accounts"
import { initWorkspace, loadWorkspaceConfig, listWorkspaceIds } from "./store"
import { pullWorkspaceMessages } from "./runtime"
import { verboseLog } from "../Verbose"
import { DEFAULT_GMAIL_WORKSPACE_QUERY } from "../defaults"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let resolveWorkspaceDir = (dir?: string) => {
  let resolved = path.resolve(dir ?? ".")
  fs.mkdirSync(resolved, { recursive: true })
  setWorkspaceDir(resolved)
  return resolved
}

let withDir = (y: Argv) =>
  y.positional("dir", {
    type: "string",
    describe: "Server workspace directory (defaults to current directory)",
  })

export let configureServerCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [dir] [options]")
    .command(
      "init [dir]",
      "Create or initialize a server workspace in a directory",
      y =>
        withDir(y)
          .option("name", {
            type: "string",
            describe: "Server workspace display name (defaults to directory name)",
          })
          .option("account", {
            type: "array",
            string: true,
            coerce: normalizeMultiValue,
            describe: "Account(s) to ingest from (repeatable, comma-separated). If omitted, infer from local .msgmon token files.",
          })
          .option("query", {
            type: "string",
            default: DEFAULT_GMAIL_WORKSPACE_QUERY,
            describe: "Default ingest query",
          })
          .option("pull-window-days", {
            type: "number",
            default: 14,
            describe: "Default lookback window in days when --since is omitted and no messages exist yet",
          })
          .option("overwrite", {
            type: "boolean",
            default: false,
            describe: "Overwrite an existing server directory workspace",
          }),
      async argv => {
        let dir = resolveWorkspaceDir(argv.dir)
        let inferredAccounts = !argv.account || argv.account.length === 0
        let accounts: string[] = inferredAccounts ? inferWorkspaceAccounts() : (argv.account ?? [])
        if (accounts.length === 0) {
          throw new Error("No accounts provided and none inferred from ./.msgmon/<platform>/tokens/")
        }

        let result = initWorkspace(DEFAULT_WORKSPACE_ID, {
          name: argv.name ?? path.basename(dir),
          accounts,
          query: argv.query,
          pullWindowDays: argv.pullWindowDays,
          overwrite: argv.overwrite,
        })

        console.log(JSON.stringify({
          created: true,
          workspaceId: result.config.id,
          path: result.path,
          config: result.config,
          inferredAccounts,
        }, null, 2))
      },
    )
    .command(
      "pull [dir]",
      "Pull messages into the server workspace messages/ directory",
      y =>
        withDir(y)
          .option("max-results", {
            type: "number",
            default: 100,
            describe: "Maximum messages per account per pull",
          })
          .option("mark-read", {
            type: "boolean",
            default: false,
            describe: "Mark messages as read after successful pull",
          })
          .option("save-attachments", {
            type: "boolean",
            default: false,
            describe: "Download and save attachments",
          })
          .option("seed", {
            type: "boolean",
            default: false,
            describe: "Record IDs in state without writing message files",
          })
          .option("query", {
            type: "string",
            describe: "Override the configured Gmail query for this pull",
          })
          .option("slack-channels", {
            type: "array",
            string: true,
            coerce: normalizeMultiValue,
            describe: "Override monitored Slack channels for this pull (repeatable, comma-separated)",
          })
          .option("since", {
            type: "string",
            describe: "Lower time bound as ISO timestamp or YYYY-MM-DD. Defaults to the newest pulled message timestamp, or the configured pull window when empty.",
          })
          .option("until", {
            type: "string",
            describe: "Upper time bound as ISO timestamp or YYYY-MM-DD. Defaults to the current timestamp.",
          })
          .option("clear", {
            type: "boolean",
            default: false,
            describe: "Clear messages/ and reset pull state before pulling",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        let dir = resolveWorkspaceDir(argv.dir)
        verboseLog(argv.verbose, "server pull", { dir, maxResults: argv.maxResults, since: argv.since, until: argv.until })
        let result = await pullWorkspaceMessages({
          workspaceId: DEFAULT_WORKSPACE_ID,
          maxResults: argv.maxResults,
          markRead: argv.markRead,
          saveAttachments: argv.saveAttachments,
          seed: argv.seed,
          query: argv.query,
          slackChannels: argv.slackChannels,
          since: argv.since,
          until: argv.until,
          clear: argv.clear,
          verbose: argv.verbose,
        })
        console.log(JSON.stringify({ path: dir, workspaceId: DEFAULT_WORKSPACE_ID, ...result }, null, 2))
      },
    )
    .command(
      "show [dir]",
      "Show server workspace configuration for a directory",
      y => withDir(y),
      async argv => {
        resolveWorkspaceDir(argv.dir)
        console.log(JSON.stringify(loadWorkspaceConfig(DEFAULT_WORKSPACE_ID), null, 2))
      },
    )
    .command(
      "list [dir]",
      "Show whether a directory contains a server workspace",
      y => withDir(y),
      async argv => {
        let dir = resolveWorkspaceDir(argv.dir)
        console.log(JSON.stringify({ path: dir, workspaces: listWorkspaceIds() }, null, 2))
      },
    )
    .demandCommand(1, "Choose a command: init, pull, show, or list.")
    .strict()
    .help()

export let parseServerCli = (args: string[], scriptName = "msgmon server") =>
  configureServerCli(yargs(args).scriptName(scriptName)).parseAsync()

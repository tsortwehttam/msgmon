import fs from "node:fs"
import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { setWorkspaceDir } from "../CliConfig"
import { DEFAULT_WORKSPACE_ID } from "../defaults"
import { inferWorkspaceAccounts } from "./accounts"
import { initWorkspace, loadWorkspaceConfig, listWorkspaceIds } from "./store"
import { refreshWorkspace, syncWorkspaceContext } from "./runtime"
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
          .option("context-window-days", {
            type: "number",
            default: 14,
            describe: "Default historical context window in days",
          })
          .option("context-max-results", {
            type: "number",
            default: 200,
            describe: "Maximum historical context messages to sync per account",
          })
          .option("context-query", {
            type: "string",
            describe: "Optional Gmail-only base query for historical context sync",
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
          contextWindowDays: argv.contextWindowDays,
          contextMaxResults: argv.contextMaxResults,
          contextQuery: argv.contextQuery,
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
      "refresh [dir]",
      "Ingest new messages into the server workspace inbox",
      y =>
        withDir(y)
          .option("max-results", {
            type: "number",
            default: 100,
            describe: "Maximum messages per account per refresh",
          })
          .option("mark-read", {
            type: "boolean",
            default: false,
            describe: "Mark messages as read after successful ingest",
          })
          .option("save-attachments", {
            type: "boolean",
            default: false,
            describe: "Download and save attachments",
          })
          .option("seed", {
            type: "boolean",
            default: false,
            describe: "Record IDs in state without writing inbox files",
          })
          .option("sync-context", {
            type: "boolean",
            default: false,
            describe: "Also sync historical context into context/",
          })
          .option("context-max-results", {
            type: "number",
            describe: "Override context max-results for this run",
          })
          .option("context-since", {
            type: "string",
            describe: "Backfill context since YYYY-MM-DD",
          })
          .option("clear-context", {
            type: "boolean",
            default: false,
            describe: "Clear context/ and reset its state before syncing",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        let dir = resolveWorkspaceDir(argv.dir)
        verboseLog(argv.verbose, "server refresh", { dir, maxResults: argv.maxResults })
        let result = await refreshWorkspace({
          workspaceId: DEFAULT_WORKSPACE_ID,
          maxResults: argv.maxResults,
          markRead: argv.markRead,
          saveAttachments: argv.saveAttachments,
          seed: argv.seed,
          syncContext: argv.syncContext,
          contextMaxResults: argv.contextMaxResults,
          contextSince: argv.contextSince,
          clearContext: argv.clearContext,
          verbose: argv.verbose,
        })
        console.log(JSON.stringify({ path: dir, workspaceId: DEFAULT_WORKSPACE_ID, ...result }, null, 2))
      },
    )
    .command(
      "context-sync [dir]",
      "Sync historical context into context/",
      y =>
        withDir(y)
          .option("max-results", {
            type: "number",
            default: 200,
            describe: "Maximum context messages per account per sync",
          })
          .option("since", {
            type: "string",
            describe: "Backfill context since YYYY-MM-DD",
          })
          .option("clear", {
            type: "boolean",
            default: false,
            describe: "Clear context/ and reset its state before syncing",
          })
          .option("save-attachments", {
            type: "boolean",
            default: false,
            describe: "Download and save attachments into context/",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        let dir = resolveWorkspaceDir(argv.dir)
        let result = await syncWorkspaceContext({
          workspaceId: DEFAULT_WORKSPACE_ID,
          maxResults: argv.maxResults,
          saveAttachments: argv.saveAttachments,
          verbose: argv.verbose,
          since: argv.since,
          clear: argv.clear,
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
    .demandCommand(1, "Choose a command: init, refresh, context-sync, show, or list.")
    .strict()
    .help()

export let parseServerCli = (args: string[], scriptName = "msgmon server") =>
  configureServerCli(yargs(args).scriptName(scriptName)).parseAsync()

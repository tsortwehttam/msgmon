import yargs from "yargs"
import type { Argv } from "yargs"
import { initWorkspace, loadWorkspaceConfig, listWorkspaceIds } from "./store"
import { inferWorkspaceAccounts } from "./accounts"
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

export let configureWorkspaceCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .command(
      "init <id>",
      "Create a server-managed workspace under .msgmon/workspaces/<id>",
      y =>
        y
          .positional("id", {
            type: "string",
            demandOption: true,
            describe: "Workspace identifier",
          })
          .option("name", {
            type: "string",
            describe: "Workspace display name (defaults to id)",
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
            describe: "Default historical context window in days for workspace/context",
          })
          .option("context-max-results", {
            type: "number",
            default: 200,
            describe: "Maximum historical context messages to sync per account",
          })
          .option("context-query", {
            type: "string",
            describe: "Optional Gmail-only base query for historical context sync",
          }),
      async argv => {
        let inferredAccounts = !argv.account || argv.account.length === 0
        let accounts: string[] = inferredAccounts ? inferWorkspaceAccounts() : (argv.account ?? [])
        if (accounts.length === 0) {
          throw new Error("No accounts provided and none inferred from ./.msgmon/<platform>/tokens/")
        }

        let result = initWorkspace(argv.id!, {
          name: argv.name,
          accounts,
          query: argv.query,
          contextWindowDays: argv.contextWindowDays,
          contextMaxResults: argv.contextMaxResults,
          contextQuery: argv.contextQuery,
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
      "refresh <id>",
      "Ingest new messages into the server-owned workspace inbox",
      y =>
        y
          .positional("id", {
            type: "string",
            demandOption: true,
            describe: "Workspace identifier",
          })
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
            describe: "Also sync historical context into workspace/context",
          })
          .option("context-max-results", {
            type: "number",
            describe: "Override workspace context max-results for this run",
          })
          .option("context-since", {
            type: "string",
            describe: "Backfill Gmail context since YYYY-MM-DD",
          })
          .option("clear-context", {
            type: "boolean",
            default: false,
            describe: "Clear workspace/context and reset its state before syncing",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        verboseLog(argv.verbose, "workspace refresh", {
          workspaceId: argv.id,
          maxResults: argv.maxResults,
          markRead: argv.markRead,
          saveAttachments: argv.saveAttachments,
          seed: argv.seed,
        })

        let result = await refreshWorkspace({
          workspaceId: argv.id!,
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

        console.log(JSON.stringify({
          workspaceId: argv.id,
          ...result,
        }, null, 2))
      },
    )
    .command(
      "context-sync <id>",
      "Sync historical context into the server-owned workspace context directory",
      y =>
        y
          .positional("id", {
            type: "string",
            demandOption: true,
            describe: "Workspace identifier",
          })
          .option("max-results", {
            type: "number",
            default: 200,
            describe: "Maximum context messages per account per sync",
          })
          .option("since", {
            type: "string",
            describe: "Backfill Gmail context since YYYY-MM-DD",
          })
          .option("clear", {
            type: "boolean",
            default: false,
            describe: "Clear workspace/context and reset its state before syncing",
          })
          .option("save-attachments", {
            type: "boolean",
            default: false,
            describe: "Download and save attachments into context message directories",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        let result = await syncWorkspaceContext({
          workspaceId: argv.id!,
          maxResults: argv.maxResults,
          saveAttachments: argv.saveAttachments,
          verbose: argv.verbose,
          since: argv.since,
          clear: argv.clear,
        })

        console.log(JSON.stringify({
          workspaceId: argv.id,
          ...result,
        }, null, 2))
      },
    )
    .command(
      "show <id>",
      "Show workspace configuration",
      y =>
        y.positional("id", {
          type: "string",
          demandOption: true,
          describe: "Workspace identifier",
        }),
      async argv => {
        let config = loadWorkspaceConfig(argv.id!)
        console.log(JSON.stringify(config, null, 2))
      },
    )
    .command(
      "list",
      "List workspace ids",
      () => {},
      async () => {
        console.log(JSON.stringify({ workspaces: listWorkspaceIds() }, null, 2))
      },
    )
    .demandCommand(1, "Choose a command: init, refresh, context-sync, show, or list.")
    .strict()
    .help()

export let parseWorkspaceCli = (args: string[], scriptName = "msgmon workspace") =>
  configureWorkspaceCli(yargs(args).scriptName(scriptName)).parseAsync()

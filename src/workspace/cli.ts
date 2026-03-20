import fs from "node:fs"
import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { initWorkspace, loadWorkspaceConfig } from "./init"
import { createWorkspaceHookSink } from "./hook"
import { createDirSink, createChainSink } from "../ingest/sinks"
import { watch, buildDefaultStatePath } from "../ingest/ingest"
import { gmailSource, markGmailRead, fetchGmailAttachment } from "../../platforms/gmail/MailSource"
import { slackSource, markSlackRead } from "../../platforms/slack/SlackSource"
import type { MessageSource } from "../ingest/ingest"
import type { UnifiedMessage } from "../types"
import { verboseLog } from "../Verbose"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let resolveSources = (accounts: string[]): Array<{ source: MessageSource; accounts: string[] }> => {
  let gmailAccounts: string[] = []
  let slackAccounts: string[] = []

  for (let account of accounts) {
    if (account.startsWith("slack:")) {
      slackAccounts.push(account.slice("slack:".length))
    } else {
      gmailAccounts.push(account)
    }
  }

  let sources: Array<{ source: MessageSource; accounts: string[] }> = []
  if (gmailAccounts.length) sources.push({ source: gmailSource, accounts: gmailAccounts })
  if (slackAccounts.length) sources.push({ source: slackSource, accounts: slackAccounts })
  return sources
}

let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
  if (msg.platform === "slack") return markSlackRead(msg, account)
  return markGmailRead(msg, account)
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
            "on-message.sh",
            "inbox/",
            "drafts/",
            "corpus/",
          ],
        }, null, 2))

        console.error(`\nWorkspace created at ${result.path}`)
        console.error(`\nNext steps:`)
        console.error(`  1. Edit ${path.join(result.path, "user-profile.md")} with your info`)
        console.error(`  2. Edit ${path.join(result.path, "instructions.md")} to customize agent behavior`)
        console.error(`  3. Edit ${path.join(result.path, "on-message.sh")} to wire up your agent`)
        console.error(`  4. Seed historical messages:`)
        console.error(`     msgmon ingest --seed --query='newer_than:30d' --sink=dir --out-dir=${path.join(result.path, "inbox")}`)
        console.error(`  5. Start watching:`)
        console.error(`     msgmon workspace watch ${result.path}`)
      },
    )
    .command(
      "watch [path]",
      "Watch for new messages using workspace config, save to inbox, and run on-message hook",
      y =>
        y
          .positional("path", {
            type: "string",
            default: ".",
            describe: "Workspace directory (default: current directory)",
          })
          .option("mark-read", {
            type: "boolean",
            default: false,
            describe: "Mark messages as read after ingestion",
          })
          .option("save-attachments", {
            type: "boolean",
            default: false,
            describe: "Download and save attachments",
          })
          .option("no-hook", {
            type: "boolean",
            default: false,
            describe: "Skip running the on-message hook (just ingest to inbox)",
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            default: false,
            describe: "Print diagnostic details to stderr",
          }),
      async argv => {
        let wsDir = path.resolve(argv.path!)
        let config = loadWorkspaceConfig(wsDir)
        let inboxDir = path.join(wsDir, "inbox")
        let accounts = config.accounts

        let dirSink = createDirSink({
          outDir: inboxDir,
          saveAttachments: argv.saveAttachments,
          fetchAttachment: argv.saveAttachments
            ? (msg, filename) => fetchGmailAttachment(msg, filename, accounts[0] ?? "default")
            : undefined,
        })

        let hookCommand = config.onMessage && !argv.noHook
          ? path.resolve(wsDir, config.onMessage)
          : null

        let sink = hookCommand && fs.existsSync(hookCommand)
          ? createChainSink([
              dirSink,
              createWorkspaceHookSink({
                command: hookCommand,
                workspaceDir: wsDir,
                inboxDir,
              }),
            ])
          : dirSink

        if (hookCommand && !fs.existsSync(hookCommand)) {
          console.error(`[workspace] Warning: onMessage hook "${hookCommand}" not found, skipping hook`)
        }

        let statePath = buildDefaultStatePath({ accounts, query: config.query })

        verboseLog(argv.verbose, "workspace watch", {
          workspace: wsDir,
          accounts,
          query: config.query,
          intervalMs: config.watchIntervalMs,
          hook: hookCommand,
        })

        console.error(`[workspace] watching ${config.name} — accounts: ${accounts.join(", ")} — query: ${config.query}`)
        console.error(`[workspace] inbox: ${inboxDir}`)
        if (hookCommand && fs.existsSync(hookCommand)) {
          console.error(`[workspace] on-message hook: ${hookCommand}`)
        }

        await watch({
          sources: resolveSources(accounts),
          query: config.query,
          maxResults: 100,
          sink,
          statePath,
          markRead: resolveMarkRead,
          doMarkRead: argv.markRead,
          seed: false,
          verbose: argv.verbose,
          intervalMs: config.watchIntervalMs,
        })
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
    .demandCommand(1, "Choose a command: init, watch, or show.")
    .strict()
    .help()

export let parseWorkspaceCli = (args: string[], scriptName = "msgmon workspace") =>
  configureWorkspaceCli(yargs(args).scriptName(scriptName)).parseAsync()

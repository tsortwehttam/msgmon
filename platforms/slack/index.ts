/**
 * Slack platform CLI.
 *
 * Credentials layout:
 *   .msgmon/slack/credentials.json      — Slack app manifest (client_id, client_secret)
 *   .msgmon/slack/tokens/<account>.json  — Bot + optional user tokens per workspace
 *
 * CLI subcommands:
 *   msgmon slack auth       — Store bot token or run OAuth install flow
 *   msgmon slack accounts   — List configured Slack workspaces
 *   msgmon slack search     — Search messages (requires user token with search:read)
 *   msgmon slack read       — Read a message by channel + ts
 *   msgmon slack send       — Post a message to a channel
 */

import fs from "node:fs"
import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { DEFAULT_ACCOUNT } from "../../src/CliConfig"
import { slackClients, slackReadClient, uploadFilesToChannel, postMessageWithJoinFallback } from "./slackClient"
import { toUnifiedMessage, type UserCache } from "./toUnifiedMessage"
import type { SlackMessage } from "./toUnifiedMessage"

export let configureSlackCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .option("account", {
      type: "string",
      default: DEFAULT_ACCOUNT,
      describe: "Slack workspace account name (uses .msgmon/slack/tokens/<account>.json)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .command(
      "auth [args..]",
      "Store a bot token or run Slack OAuth install flow",
      y =>
        y
          .parserConfiguration({ "unknown-options-as-args": true })
          .positional("args", {
            type: "string",
            array: true,
            describe: "Arguments forwarded to `msgmon slack auth`",
          }),
      async argv => {
        let { parseAuthCli } = await import("./auth")
        await parseAuthCli((argv.args as string[] | undefined) ?? [], "msgmon slack auth")
      },
    )
    .command(
      "accounts [args..]",
      "List configured Slack workspaces",
      y =>
        y
          .parserConfiguration({ "unknown-options-as-args": true })
          .positional("args", {
            type: "string",
            array: true,
            describe: "Arguments forwarded to `msgmon slack accounts`",
          }),
      async argv => {
        let { parseAccountsCli } = await import("./accounts")
        await parseAccountsCli((argv.args as string[] | undefined) ?? [], "msgmon slack accounts")
      },
    )
    .command(
      "search <query>",
      "Search Slack messages (requires user token with search:read scope)",
      y =>
        y
          .positional("query", { type: "string", demandOption: true, describe: "Search query" })
          .option("max-results", { type: "number", default: 20, describe: "Maximum results" })
          .option("format", {
            type: "string",
            choices: ["json", "text"] as const,
            default: "json",
            describe: "Output format",
          }),
      async argv => {
        let clients = slackClients(argv.account, argv.verbose)
        if (!clients.user) {
          throw new Error(
            "search requires a user token (xoxp-). Run: msgmon slack auth --mode=oauth",
          )
        }
        let res = await clients.user.search.messages({
          query: argv.query!,
          count: argv.maxResults,
          sort: "timestamp",
          sort_dir: "desc",
        })

        let matches = (res.messages as { matches?: unknown[] } | undefined)?.matches ?? []

        if (argv.format === "text") {
          for (let m of matches as Array<{ ts?: string; channel?: { name?: string }; text?: string }>) {
            let ch = m.channel?.name ?? "?"
            let text = (m.text ?? "").slice(0, 120).replace(/\n/g, " ")
            console.log(`#${ch}  ${m.ts}  ${text}`)
          }
        } else {
          console.log(JSON.stringify(matches, null, 2))
        }
      },
    )
    .command(
      "read <channel> <ts>",
      "Read a Slack message by channel and timestamp",
      y =>
        y
          .positional("channel", { type: "string", demandOption: true, describe: "Channel ID or #name" })
          .positional("ts", { type: "string", demandOption: true, describe: "Message timestamp" }),
      async argv => {
        let clients = slackClients(argv.account, argv.verbose)
        let reader = slackReadClient(clients)

        // Resolve channel name to ID if needed
        let channelId = argv.channel!
        let channelName = argv.channel!
        if (channelId.startsWith("#")) {
          let res = await reader.conversations.list({
            types: "public_channel,private_channel",
            limit: 1000,
          })
          let match = (res.channels ?? []).find(c => c.name === channelId.replace(/^#/, ""))
          if (!match?.id) throw new Error(`Channel "${channelId}" not found`)
          channelName = match.name ?? channelId
          channelId = match.id
        }

        let res = await reader.conversations.history({
          channel: channelId,
          latest: argv.ts,
          inclusive: true,
          limit: 1,
        })

        let msg = (res.messages ?? [])[0]
        if (!msg) {
          console.error(`No message found at ${channelId}:${argv.ts}`)
          process.exit(1)
        }

        let userCache: UserCache = new Map()
        if (msg.user) {
          try {
            let u = await reader.users.info({ user: msg.user })
            let name = u.user?.profile?.display_name || u.user?.profile?.real_name || u.user?.name
            if (name) userCache.set(msg.user, name)
          } catch { /* proceed without name */ }
        }

        let unified = toUnifiedMessage(msg as SlackMessage, {
          channelId,
          channelName,
          teamId: clients.teamId ?? "",
          userCache,
        })
        console.log(JSON.stringify(unified, null, 2))
      },
    )
    .command(
      "send",
      "Post a message to a Slack channel",
      y =>
        y
          .option("channel", {
            type: "string",
            demandOption: true,
            describe: "Channel ID or #name",
          })
          .option("text", {
            type: "string",
            default: "",
            describe: "Message text to send",
          })
          .option("as-user", {
            type: "boolean",
            default: true,
            describe: "Send as the authenticated user (requires user token; falls back to bot)",
          })
          .option("thread-ts", {
            type: "string",
            describe: "Thread timestamp to reply to",
          })
          .option("attach", {
            type: "array",
            string: true,
            default: [] as string[],
            describe: "Attachment file path(s), repeatable",
          })
          .check(argv => {
            if (!argv.text && argv.attach.length === 0) {
              throw new Error("at least one of --text or --attach is required")
            }
            return true
          }),
      async argv => {
        let clients = slackClients(argv.account, argv.verbose)
        let reader = slackReadClient(clients)

        // Prefer user token for sending as user, fall back to bot
        let sendClient = argv.asUser && clients.user ? clients.user : clients.bot

        // Resolve channel name
        let channelId = argv.channel
        if (channelId.startsWith("#")) {
          let res = await reader.conversations.list({
            types: "public_channel,private_channel",
            limit: 1000,
          })
          let match = (res.channels ?? []).find(c => c.name === channelId.replace(/^#/, ""))
          if (!match?.id) throw new Error(`Channel "${channelId}" not found`)
          channelId = match.id
        }

        // Send text message if present
        let messageResult: { ok?: boolean; ts?: string; channel?: string } | null = null
        if (argv.text) {
          let res = await postMessageWithJoinFallback({
            clients,
            sendClient,
            channelId,
            text: argv.text,
            threadTs: argv.threadTs,
          })
          messageResult = { ok: res.ok, ts: res.ts, channel: res.channel }
        }

        // Upload attachments if present
        let filesUploaded = 0
        if (argv.attach.length > 0) {
          let files = argv.attach.map(filePath => ({
            filename: path.basename(filePath),
            data: fs.readFileSync(filePath),
          }))
          await uploadFilesToChannel(sendClient, channelId, files, {
            threadTs: argv.threadTs ?? messageResult?.ts,
            initialComment: messageResult ? undefined : argv.text || undefined,
          })
          filesUploaded = files.length
        }

        console.log(JSON.stringify({
          ok: messageResult?.ok ?? true,
          ts: messageResult?.ts,
          channel: messageResult?.channel ?? channelId,
          filesUploaded,
        }))
      },
    )
    .demandCommand(1, "Choose a command: auth, accounts, search, read, or send.")
    .strict()
    .help()

export let parseSlackCli = (args: string[], scriptName = "slack") =>
  configureSlackCli(yargs(args).scriptName(scriptName)).parseAsync()

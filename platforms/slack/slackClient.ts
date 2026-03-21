import fs from "node:fs"
import { WebClient } from "@slack/web-api"
import { resolveTokenReadPathForAccount } from "../../src/CliConfig"
import { verboseLog } from "../../src/Verbose"

export type SlackTokenFile = {
  bot_token: string
  user_token?: string
  team_id?: string
  team_name?: string
}

export type SlackClients = {
  bot: WebClient
  user?: WebClient
  teamId?: string
  teamName?: string
  tokenFile: SlackTokenFile
}

export let slackReadClient = (clients: SlackClients) => clients.user ?? clients.bot

let isSlackNotInChannelError = (err: unknown) => {
  let message = err instanceof Error ? err.message : String(err)
  return message.includes("not_in_channel")
}

export let postMessageWithJoinFallback = async (params: {
  clients: SlackClients
  sendClient: WebClient
  channelId: string
  text: string
  threadTs?: string
}) => {
  try {
    return await params.sendClient.chat.postMessage({
      channel: params.channelId,
      text: params.text,
      thread_ts: params.threadTs,
    })
  } catch (err) {
    // Only retry for bot-token sends that can join public channels on demand.
    if (params.sendClient !== params.clients.bot || !isSlackNotInChannelError(err)) throw err
    await params.clients.bot.conversations.join({ channel: params.channelId })
    return await params.clients.bot.chat.postMessage({
      channel: params.channelId,
      text: params.text,
      thread_ts: params.threadTs,
    })
  }
}

export let loadSlackTokenFile = (account: string): SlackTokenFile => {
  let tokenPath = resolveTokenReadPathForAccount(account, "slack")
  let raw = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
  if (!raw.bot_token) throw new Error(`Token file for "${account}" is missing bot_token`)
  return raw as SlackTokenFile
}

export let uploadFilesToChannel = async (
  client: WebClient,
  channelId: string,
  files: Array<{ filename: string; data: Buffer }>,
  opts?: { threadTs?: string; initialComment?: string },
) => {
  let results = []
  for (let file of files) {
    let baseRequest: {
      channel_id: string
      file: Buffer
      filename: string
      title: string
      initial_comment?: string
    } = {
      channel_id: channelId,
      file: file.data,
      filename: file.filename,
      title: file.filename,
      initial_comment: results.length === 0 ? opts?.initialComment : undefined,
    }
    let r: Awaited<ReturnType<WebClient["filesUploadV2"]>> = opts?.threadTs
      ? await client.filesUploadV2({ ...baseRequest, thread_ts: opts.threadTs })
      : await client.filesUploadV2(baseRequest)
    results.push(r)
  }
  return results
}

export let slackClients = (account: string, verbose = false): SlackClients => {
  let tokenFile = loadSlackTokenFile(account)
  verboseLog(verbose, "slack auth", {
    account,
    hasBot: !!tokenFile.bot_token,
    hasUser: !!tokenFile.user_token,
    teamId: tokenFile.team_id,
  })
  return {
    bot: new WebClient(tokenFile.bot_token),
    user: tokenFile.user_token ? new WebClient(tokenFile.user_token) : undefined,
    teamId: tokenFile.team_id,
    teamName: tokenFile.team_name,
    tokenFile,
  }
}

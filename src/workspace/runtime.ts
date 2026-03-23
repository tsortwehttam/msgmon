import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { prependConfigDir, LOCAL_CONFIG_DIRNAME } from "../CliConfig"
import { createJsonlFileSink } from "../ingest/sinks"
import { ingestOnce } from "../ingest/ingest"
import { gmailSource, markGmailRead, fetchGmailAttachment } from "../../platforms/gmail/MailSource"
import { slackSource, markSlackRead } from "../../platforms/slack/SlackSource"
import type { MessageSource } from "../ingest/ingest"
import type { UnifiedMessage } from "../types"
import { loadWorkspaceConfig, workspaceRoot, workspaceStateRoot } from "./store"

type SourceSpec = { source: MessageSource; accounts: string[]; query?: string; oldest?: string; latest?: string }

let splitAccounts = (accounts: string[]) => {
  let gmailAccounts: string[] = []
  let slackAccounts: string[] = []

  for (let account of accounts) {
    if (account.startsWith("slack:")) slackAccounts.push(account.slice("slack:".length))
    else gmailAccounts.push(account)
  }

  return { gmailAccounts, slackAccounts }
}

let normalizeDateForGmail = (value?: string) => value?.replace(/-/g, "/")
let isDateOnly = (value?: string) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)

let buildPullGmailQuery = (params: { baseQuery: string; since?: string; until?: string }) => {
  let terms = [params.baseQuery.trim()]
  let since = isDateOnly(params.since) ? normalizeDateForGmail(params.since) : undefined
  let until = isDateOnly(params.until) ? normalizeDateForGmail(params.until) : undefined
  if (since) terms.push(`after:${since}`)
  if (until) terms.push(`before:${until}`)
  return terms.filter(Boolean).join(" ").trim()
}

let resolvePullSources = (params: {
  accounts: string[]
  query: string
  slackChannels?: Record<string, string[]>
  since?: string
  until?: string
  slackChannelsOverride?: Record<string, string[]>
}): SourceSpec[] => {
  let { gmailAccounts, slackAccounts } = splitAccounts(params.accounts)
  let sources: SourceSpec[] = []
  if (gmailAccounts.length) {
    sources.push({
      source: gmailSource,
      accounts: gmailAccounts,
      query: buildPullGmailQuery({
        baseQuery: params.query,
        since: params.since,
        until: params.until,
      }),
      oldest: params.since,
      latest: params.until,
    })
  }
  if (slackAccounts.length) {
    let channelMap = params.slackChannelsOverride && Object.keys(params.slackChannelsOverride).length
      ? params.slackChannelsOverride
      : params.slackChannels
    for (let account of slackAccounts) {
      let channels = channelMap?.[account] ?? channelMap?.["*"] ?? []
      let slackQuery = channels.join(",")
      sources.push({
        source: slackSource,
        accounts: [account],
        query: slackQuery,
        oldest: params.since,
        latest: params.until,
      })
    }
  }
  return sources
}

let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
  if (msg.platform === "slack") return markSlackRead(msg, account)
  return markGmailRead(msg, account)
}

let attachmentFetcher = (accounts: string[]) =>
  async (msg: UnifiedMessage, filename: string) => fetchGmailAttachment(msg, filename, accounts[0] ?? "default")

let resolveMessagesPath = (workspaceId: string) =>
  path.resolve(workspaceRoot(workspaceId), "messages.jsonl")

let timestampMs = (value?: string) => {
  if (!value) return undefined
  let ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp "${value}"`)
  return ms
}

export let sortMessagesJsonl = (filePath: string) => {
  if (!fs.existsSync(filePath)) return
  let raw = fs.readFileSync(filePath, "utf8")
  let entries = raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ line, index }))
    .map(({ line, index }) => ({
      line,
      index,
      msg: JSON.parse(line) as { timestamp?: string; platform?: string; id?: string },
    }))

  entries.sort((a, b) => {
    let aTs = timestampMs(a.msg.timestamp) ?? 0
    let bTs = timestampMs(b.msg.timestamp) ?? 0
    if (aTs !== bTs) return aTs - bTs
    let aPlatform = a.msg.platform ?? ""
    let bPlatform = b.msg.platform ?? ""
    if (aPlatform !== bPlatform) return aPlatform.localeCompare(bPlatform)
    let aId = a.msg.id ?? ""
    let bId = b.msg.id ?? ""
    if (aId !== bId) return aId.localeCompare(bId)
    return a.index - b.index
  })

  fs.writeFileSync(filePath, entries.map(entry => entry.line).join("\n") + (entries.length ? "\n" : ""))
}

export let latestPulledMessageTimestamp = (workspaceId: string) => {
  let filePath = resolveMessagesPath(workspaceId)
  if (!fs.existsSync(filePath)) return Promise.resolve(undefined)

  return new Promise<string | undefined>((resolve, reject) => {
    let latest: string | undefined
    let stream = fs.createReadStream(filePath, { encoding: "utf8" })
    let lines = readline.createInterface({ input: stream, crlfDelay: Infinity })

    lines.on("line", line => {
      let trimmed = line.trim()
      if (!trimmed) return
      try {
        let raw = JSON.parse(trimmed) as { timestamp?: string }
        let timestamp = raw.timestamp
        if (!timestamp) return
        if (!latest || Date.parse(timestamp) > Date.parse(latest)) latest = timestamp
      } catch {
        return
      }
    })
    lines.on("close", () => resolve(latest))
    lines.on("error", reject)
    stream.on("error", reject)
  })
}

let defaultPullSince = async (workspaceId: string) => {
  return latestPulledMessageTimestamp(workspaceId)
}

let defaultPullUntil = () => new Date().toISOString()

export let pullWorkspaceMessages = async (params: {
  workspaceId: string
  maxResults: number
  markRead: boolean
  saveAttachments: boolean
  verbose: boolean
  query?: string
  since?: string
  until?: string
  slackChannels?: Record<string, string[]>
  clear?: boolean
}) => {
  let config = loadWorkspaceConfig(params.workspaceId)
  let root = workspaceRoot(config.id)
  let messagesPath = resolveMessagesPath(config.id)
  let effectiveQuery = params.query ?? config.query

  prependConfigDir(path.resolve(root, LOCAL_CONFIG_DIRNAME))

  if (params.clear) {
    fs.rmSync(messagesPath, { force: true })
  }

  let effectiveSince = params.since ?? await defaultPullSince(config.id)
  let effectiveUntil = params.until ?? defaultPullUntil()
  let sinceMs = timestampMs(effectiveSince)
  let untilMs = timestampMs(effectiveUntil)
  if (sinceMs != null && untilMs != null && sinceMs > untilMs) {
    throw new Error(`Invalid pull range: since ${effectiveSince} is after until ${effectiveUntil}`)
  }

  let sink = createJsonlFileSink({
    filePath: messagesPath,
    saveAttachments: params.saveAttachments,
    fetchAttachment: params.saveAttachments ? attachmentFetcher(config.accounts) : undefined,
  })

  let result = await ingestOnce({
    sources: resolvePullSources({
      accounts: config.accounts,
      query: effectiveQuery,
      slackChannels: config.slackChannels,
      slackChannelsOverride: params.slackChannels,
      since: effectiveSince,
      until: effectiveUntil,
    }),
    query: effectiveQuery,
    maxResults: params.maxResults,
    sink,
    markRead: resolveMarkRead,
    doMarkRead: params.markRead,
    seed: false,
    verbose: params.verbose,
  })

  sortMessagesJsonl(messagesPath)

  return {
    ...result,
    query: effectiveQuery,
    since: effectiveSince,
    until: effectiveUntil,
  }
}

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { prependConfigDir, LOCAL_CONFIG_DIRNAME } from "../CliConfig"
import { createJsonFileSink } from "../ingest/sinks"
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

let buildPullGmailQuery = (params: { baseQuery: string; since?: string; until?: string }) => {
  let terms = [params.baseQuery.trim()]
  let since = normalizeDateForGmail(params.since)
  let until = normalizeDateForGmail(params.until)
  if (since) terms.push(`after:${since}`)
  if (until) terms.push(`before:${until}`)
  return terms.filter(Boolean).join(" ").trim()
}

let resolvePullSources = (params: {
  accounts: string[]
  query: string
  slackChannels?: string[]
  since?: string
  until?: string
  slackChannelsOverride?: string[]
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
    let slackChannels = params.slackChannelsOverride?.length ? params.slackChannelsOverride : params.slackChannels
    let slackQuery = slackChannels?.length ? slackChannels.join(",") : ""
    sources.push({
      source: slackSource,
      accounts: slackAccounts,
      query: slackQuery,
      oldest: params.since,
      latest: params.until,
    })
  }
  return sources
}

let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
  if (msg.platform === "slack") return markSlackRead(msg, account)
  return markGmailRead(msg, account)
}

export let buildWorkspacePullStatePath = (workspaceId: string, accounts: string[], query: string, slackChannels?: string[]) => {
  let key = JSON.stringify({
    scope: "pull",
    accounts: accounts.slice().sort(),
    query,
    slackChannels: (slackChannels ?? []).slice().sort(),
  })
  let digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
  return path.resolve(workspaceStateRoot(workspaceId), `pull-${digest}.json`)
}

let attachmentFetcher = (accounts: string[]) =>
  async (msg: UnifiedMessage, filename: string) => fetchGmailAttachment(msg, filename, accounts[0] ?? "default")

let resolveMessagesDir = (workspaceId: string) =>
  path.resolve(workspaceRoot(workspaceId), "messages")

let timestampMs = (value?: string) => {
  if (!value) return undefined
  let ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp "${value}"`)
  return ms
}

export let latestPulledMessageTimestamp = (workspaceId: string) => {
  let dir = resolveMessagesDir(workspaceId)
  if (!fs.existsSync(dir)) return undefined

  let latest: string | undefined
  for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      let raw = JSON.parse(fs.readFileSync(path.resolve(dir, entry.name), "utf8")) as { timestamp?: string }
      let timestamp = raw.timestamp
      if (!timestamp) continue
      if (!latest || Date.parse(timestamp) > Date.parse(latest)) latest = timestamp
    } catch {
      continue
    }
  }
  return latest
}

let defaultPullSince = (workspaceId: string, pullWindowDays: number) => {
  let latest = latestPulledMessageTimestamp(workspaceId)
  if (latest) return latest
  return new Date(Date.now() - pullWindowDays * 24 * 60 * 60 * 1000).toISOString()
}

let defaultPullUntil = () => new Date().toISOString()

export let pullWorkspaceMessages = async (params: {
  workspaceId: string
  maxResults: number
  markRead: boolean
  saveAttachments: boolean
  seed: boolean
  verbose: boolean
  query?: string
  since?: string
  until?: string
  slackChannels?: string[]
  clear?: boolean
}) => {
  let config = loadWorkspaceConfig(params.workspaceId)
  let root = workspaceRoot(config.id)
  let messagesDir = resolveMessagesDir(config.id)
  let effectiveQuery = params.query ?? config.query
  let statePath = buildWorkspacePullStatePath(
    config.id,
    config.accounts,
    effectiveQuery,
    params.slackChannels?.length ? params.slackChannels : config.slackChannels,
  )

  prependConfigDir(path.resolve(root, LOCAL_CONFIG_DIRNAME))

  if (params.clear) {
    fs.rmSync(messagesDir, { recursive: true, force: true })
    fs.rmSync(statePath, { force: true })
  }

  let effectiveSince = params.since ?? defaultPullSince(config.id, config.pullWindowDays)
  let effectiveUntil = params.until ?? defaultPullUntil()
  let sinceMs = timestampMs(effectiveSince)
  let untilMs = timestampMs(effectiveUntil)
  if (sinceMs != null && untilMs != null && sinceMs > untilMs) {
    throw new Error(`Invalid pull range: since ${effectiveSince} is after until ${effectiveUntil}`)
  }

  let sink = createJsonFileSink({
    outDir: messagesDir,
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
    statePath,
    markRead: resolveMarkRead,
    doMarkRead: params.markRead,
    seed: params.seed,
    verbose: params.verbose,
  })

  return {
    ...result,
    query: effectiveQuery,
    since: effectiveSince,
    until: effectiveUntil,
    statePath,
  }
}

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

let resolveInboxSources = (accounts: string[], query: string, slackChannels?: string[]): SourceSpec[] => {
  let { gmailAccounts, slackAccounts } = splitAccounts(accounts)
  let sources: SourceSpec[] = []
  if (gmailAccounts.length) sources.push({ source: gmailSource, accounts: gmailAccounts, query })
  if (slackAccounts.length) {
    let slackQuery = slackChannels?.length ? slackChannels.join(",") : ""
    sources.push({ source: slackSource, accounts: slackAccounts, query: slackQuery })
  }
  return sources
}

let buildContextGmailQuery = (params: { baseQuery?: string; windowDays: number; since?: string }) => {
  let terms = [params.baseQuery?.trim()]
  if (params.since) {
    let normalized = params.since.replace(/-/g, "/")
    terms.push(`after:${normalized}`)
  } else {
    terms.push(`newer_than:${params.windowDays}d`)
  }
  return terms.filter(Boolean).join(" ")
}

let buildContextOldestIso = (params: { windowDays: number; since?: string }) => {
  if (params.since) return new Date(`${params.since}T00:00:00.000Z`).toISOString()
  return new Date(Date.now() - params.windowDays * 24 * 60 * 60 * 1000).toISOString()
}

let resolveContextSources = (params: {
  accounts: string[]
  windowDays: number
  contextQuery?: string
  slackChannels?: string[]
  since?: string
}): SourceSpec[] => {
  let { gmailAccounts, slackAccounts } = splitAccounts(params.accounts)
  let sources: SourceSpec[] = []
  if (gmailAccounts.length) {
    sources.push({
      source: gmailSource,
      accounts: gmailAccounts,
      query: buildContextGmailQuery({
        baseQuery: params.contextQuery,
        windowDays: params.windowDays,
        since: params.since,
      }),
    })
  }
  if (slackAccounts.length) {
    let slackQuery = params.slackChannels?.length ? params.slackChannels.join(",") : ""
    sources.push({
      source: slackSource,
      accounts: slackAccounts,
      query: slackQuery,
      oldest: buildContextOldestIso({ windowDays: params.windowDays, since: params.since }),
    })
  }
  return sources
}

let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
  if (msg.platform === "slack") return markSlackRead(msg, account)
  return markGmailRead(msg, account)
}

export let buildWorkspaceStatePath = (workspaceId: string, accounts: string[], query: string) => {
  let key = JSON.stringify({ scope: "inbox", accounts: accounts.slice().sort(), query })
  let digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
  return path.resolve(workspaceStateRoot(workspaceId), `ingest-${digest}.json`)
}

export let buildWorkspaceContextStatePath = (workspaceId: string) =>
  path.resolve(workspaceStateRoot(workspaceId), "context.json")

let attachmentFetcher = (accounts: string[]) =>
  async (msg: UnifiedMessage, filename: string) => fetchGmailAttachment(msg, filename, accounts[0] ?? "default")

let ingestToDirectory = async (params: {
  workspaceId: string
  outDirName: "inbox" | "context"
  sources: SourceSpec[]
  query: string
  statePath: string
  maxResults: number
  markRead: boolean
  saveAttachments: boolean
  seed: boolean
  verbose: boolean
}) => {
  let config = loadWorkspaceConfig(params.workspaceId)
  let root = workspaceRoot(config.id)
  let outDir = path.resolve(root, params.outDirName)

  prependConfigDir(path.resolve(root, LOCAL_CONFIG_DIRNAME))

  let dirSink = createJsonFileSink({
    outDir,
    saveAttachments: params.saveAttachments,
    fetchAttachment: params.saveAttachments ? attachmentFetcher(config.accounts) : undefined,
  })

  return ingestOnce({
    sources: params.sources,
    query: params.query,
    maxResults: params.maxResults,
    sink: dirSink,
    statePath: params.statePath,
    markRead: resolveMarkRead,
    doMarkRead: params.markRead,
    seed: params.seed,
    verbose: params.verbose,
  })
}

export let refreshWorkspace = async (params: {
  workspaceId: string
  maxResults: number
  markRead: boolean
  saveAttachments: boolean
  seed: boolean
  verbose: boolean
  syncContext?: boolean
  contextMaxResults?: number
  contextSaveAttachments?: boolean
  contextSince?: string
  clearContext?: boolean
}) => {
  let config = loadWorkspaceConfig(params.workspaceId)

  let inbox = await ingestToDirectory({
    workspaceId: params.workspaceId,
    outDirName: "inbox",
    sources: resolveInboxSources(config.accounts, config.query, config.slackChannels),
    query: config.query,
    statePath: buildWorkspaceStatePath(config.id, config.accounts, config.query),
    maxResults: params.maxResults,
    markRead: params.markRead,
    saveAttachments: params.saveAttachments,
    seed: params.seed,
    verbose: params.verbose,
  })

  if (!params.syncContext) return { ...inbox, context: undefined }

  let context = await syncWorkspaceContext({
    workspaceId: params.workspaceId,
    maxResults: params.contextMaxResults ?? config.contextMaxResults,
    saveAttachments: params.contextSaveAttachments ?? false,
    verbose: params.verbose,
    since: params.contextSince,
    clear: params.clearContext,
  })

  return { ...inbox, context }
}

export let syncWorkspaceContext = async (params: {
  workspaceId: string
  maxResults: number
  saveAttachments: boolean
  verbose: boolean
  since?: string
  clear?: boolean
}) => {
  let config = loadWorkspaceConfig(params.workspaceId)
  let root = workspaceRoot(config.id)
  let contextDir = path.resolve(root, "context")
  let statePath = buildWorkspaceContextStatePath(config.id)

  prependConfigDir(path.resolve(root, LOCAL_CONFIG_DIRNAME))

  if (params.clear) {
    fs.rmSync(contextDir, { recursive: true, force: true })
    fs.rmSync(statePath, { force: true })
    fs.mkdirSync(contextDir, { recursive: true })
  }

  return ingestToDirectory({
    workspaceId: params.workspaceId,
    outDirName: "context",
    sources: resolveContextSources({
      accounts: config.accounts,
      windowDays: config.contextWindowDays,
      contextQuery: config.contextQuery,
      slackChannels: config.slackChannels,
      since: params.since,
    }),
    query: config.contextQuery ?? "",
    statePath,
    maxResults: params.maxResults,
    markRead: false,
    saveAttachments: params.saveAttachments,
    seed: false,
    verbose: params.verbose,
  })
}

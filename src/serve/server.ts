import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { verboseLog } from "../Verbose"
import type { MessageSource } from "../ingest/ingest"
import type { UnifiedMessage } from "../types"
import {
  GmailSearchRequest,
  GmailCountRequest,
  GmailThreadRequest,
  GmailReadRequest,
  GmailSendRequest,
  GmailModifyRequest,
  SlackSearchRequest,
  SlackReadRequest,
  SlackSendRequest,
  IngestRequest,
  DraftComposeRequest,
  DraftIdParam,
  DraftListRequest,
  DraftSendRequest,
  DraftUpdateRequest,
  type ApiResponse,
} from "./schema"
import { generateDraftId, saveDraft, loadDraft, listDrafts, deleteDraft } from "../draft/store"
import type { Draft } from "../draft/schema"
import { createWorkspaceHandlers } from "../workspace/api"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let parseBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      let raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })

let jsonResponse = (res: http.ServerResponse, status: number, body: ApiResponse) => {
  let json = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  })
  res.end(json)
}

let ok = (res: http.ServerResponse, data: unknown) =>
  jsonResponse(res, 200, { ok: true, data })

let fail = (res: http.ServerResponse, status: number, error: string) =>
  jsonResponse(res, status, { ok: false, error })

let validate = <T>(schema: z.ZodType<T>, data: unknown): { success: true; data: T } | { success: false; error: string } => {
  let result = schema.safeParse(data)
  if (!result.success) {
    let issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { success: false, error: `Validation failed: ${issues}` }
  }
  return { success: true, data: result.data }
}

// ---------------------------------------------------------------------------
// Gmail strip-html (duplicated from mail.ts to avoid coupling to CLI module)
// ---------------------------------------------------------------------------

let stripHtml = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

// ---------------------------------------------------------------------------
// Gmail handlers
// ---------------------------------------------------------------------------

let handleGmailSearch = async (body: unknown) => {
  let v = validate(GmailSearchRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let [{ gmailClient }, { headerMap, pickBody }] = await Promise.all([
    import("../../platforms/gmail/MailSource"),
    import("../../platforms/gmail/MessageExport"),
  ])

  let client = gmailClient(p.account)
  let effectiveFetch = p.fetch
  let r = await client.users.messages.list({ userId: "me", q: p.query, maxResults: p.maxResults })
  let msgs = r.data.messages ?? []
  let resolvedMessages: unknown[] | undefined

  if (effectiveFetch !== "none") {
    resolvedMessages = []
    let fetchFormat = effectiveFetch === "summary" ? "full" : effectiveFetch
    for (let msg of msgs) {
      if (!msg.id) continue
      let fetched = await client.users.messages.get({
        userId: "me",
        id: msg.id,
        format: fetchFormat as "full" | "metadata",
        ...(fetchFormat === "metadata"
          ? { metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"] }
          : {}),
      })
      if (effectiveFetch === "summary") {
        let headers = headerMap(fetched.data)
        let body = pickBody(fetched.data.payload ?? undefined)
        let preview = body.text ?? (body.html ? stripHtml(body.html) : "")
        if (preview.length > p.previewChars) preview = preview.slice(0, p.previewChars) + "..."
        resolvedMessages.push({
          id: fetched.data.id,
          threadId: fetched.data.threadId,
          from: headers.from ?? "",
          to: headers.to ?? "",
          subject: headers.subject ?? "",
          date: headers.date ?? "",
          snippet: fetched.data.snippet ?? "",
          bodyPreview: preview,
        })
      } else {
        resolvedMessages.push(fetched.data)
      }
    }
  }

  return {
    status: 200,
    data: {
      query: p.query,
      resultSizeEstimate: r.data.resultSizeEstimate ?? 0,
      returned: msgs.length,
      messages: msgs,
      ...(resolvedMessages ? { resolvedMessages } : {}),
    },
  }
}

let handleGmailCount = async (body: unknown) => {
  let v = validate(GmailCountRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let { gmailClient } = await import("../../platforms/gmail/MailSource")

  let client = gmailClient(p.account)
  let r = await client.users.messages.list({ userId: "me", q: p.query, maxResults: 1 })
  return {
    status: 200,
    data: {
      account: p.account,
      query: p.query,
      resultSizeEstimate: r.data.resultSizeEstimate ?? 0,
    },
  }
}

let handleGmailThread = async (body: unknown) => {
  let v = validate(GmailThreadRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let [{ gmailClient }, { toUnifiedMessage }] = await Promise.all([
    import("../../platforms/gmail/MailSource"),
    import("../../platforms/gmail/toUnifiedMessage"),
  ])

  let client = gmailClient(p.account)
  let r = await client.users.threads.get({ userId: "me", id: p.threadId, format: "full" })
  let messages = (r.data.messages ?? []).map(m => toUnifiedMessage(m))
  return {
    status: 200,
    data: { threadId: p.threadId, messageCount: messages.length, messages },
  }
}

let handleGmailRead = async (body: unknown) => {
  let v = validate(GmailReadRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let [{ gmailClient }, { toUnifiedMessage }] = await Promise.all([
    import("../../platforms/gmail/MailSource"),
    import("../../platforms/gmail/toUnifiedMessage"),
  ])

  let client = gmailClient(p.account)
  let r = await client.users.messages.get({ userId: "me", id: p.messageId, format: "full" })
  return { status: 200, data: toUnifiedMessage(r.data) }
}

let handleGmailMarkRead = async (body: unknown) => {
  let v = validate(GmailModifyRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let { gmailClient } = await import("../../platforms/gmail/MailSource")

  let client = gmailClient(p.account)
  let r = await client.users.messages.modify({
    userId: "me",
    id: p.messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  })
  return { status: 200, data: r.data }
}

let handleGmailArchive = async (body: unknown) => {
  let v = validate(GmailModifyRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let { gmailClient } = await import("../../platforms/gmail/MailSource")

  let client = gmailClient(p.account)
  let r = await client.users.messages.modify({
    userId: "me",
    id: p.messageId,
    requestBody: { removeLabelIds: ["INBOX"] },
  })
  return { status: 200, data: r.data }
}

let handleGmailAccounts = async (body: unknown) => {
  let { listAccounts: listGmailAccounts } = await import("../../platforms/gmail/accounts")
  let { accounts } = listGmailAccounts()
  return { status: 200, data: { accounts } }
}

// ---------------------------------------------------------------------------
// Slack handlers
// ---------------------------------------------------------------------------

let handleSlackSearch = async (body: unknown) => {
  let v = validate(SlackSearchRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let { slackClients, slackReadClient } = await import("../../platforms/slack/slackClient")

  let clients = slackClients(p.account)
  let reader = slackReadClient(clients)
  if (!clients.user) {
    return { status: 400, error: "search requires a user token (xoxp-). Run: msgmon slack auth --mode=oauth" }
  }
  let r = await clients.user.search.messages({
    query: p.query,
    count: p.maxResults,
    sort: "timestamp",
    sort_dir: "desc",
  })
  let matches = (r.messages as { matches?: unknown[] } | undefined)?.matches ?? []
  return { status: 200, data: { query: p.query, matches } }
}

let handleSlackRead = async (body: unknown) => {
  let v = validate(SlackReadRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let [{ slackClients, slackReadClient }, { toUnifiedMessage: slackToUnifiedMessage }] = await Promise.all([
    import("../../platforms/slack/slackClient"),
    import("../../platforms/slack/toUnifiedMessage"),
  ])

  let clients = slackClients(p.account)
  let reader = slackReadClient(clients)

  // Resolve channel name to ID
  let channelId = p.channel
  let channelName = p.channel
  if (channelId.startsWith("#")) {
    let r = await reader.conversations.list({
      types: "public_channel,private_channel",
      limit: 1000,
    })
    let match = (r.channels ?? []).find((c: { name?: string }) => c.name === channelId.replace(/^#/, ""))
    if (!match?.id) return { status: 404, error: `Channel "${channelId}" not found` }
    channelName = match.name ?? channelId
    channelId = match.id
  }

  let r = await reader.conversations.history({
    channel: channelId,
    latest: p.ts,
    inclusive: true,
    limit: 1,
  })
  let msg = (r.messages ?? [])[0]
  if (!msg) return { status: 404, error: `No message found at ${channelId}:${p.ts}` }

  let userCache = new Map<string, string>()
  if (msg.user) {
    try {
      let u = await reader.users.info({ user: msg.user })
      let name = u.user?.profile?.display_name || u.user?.profile?.real_name || u.user?.name
      if (name) userCache.set(msg.user, name)
    } catch { /* proceed without name */ }
  }

  let unified = slackToUnifiedMessage(msg as Parameters<typeof slackToUnifiedMessage>[0], {
    channelId,
    channelName,
    teamId: clients.teamId ?? "",
    userCache,
  })
  return { status: 200, data: unified }
}

let handleSlackAccounts = async (body: unknown) => {
  let { listSlackAccounts } = await import("../../platforms/slack/accounts")
  let { accounts } = listSlackAccounts()
  return { status: 200, data: { accounts } }
}

// ---------------------------------------------------------------------------
// Ingest handler
// ---------------------------------------------------------------------------

let handleIngest = async (body: unknown) => {
  let v = validate(IngestRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let [{ ingestOnce, buildDefaultStatePath }, gmailMail, slackMail] = await Promise.all([
    import("../ingest/ingest"),
    import("../../platforms/gmail/MailSource"),
    import("../../platforms/slack/SlackSource"),
  ])

  let statePath = p.state
    ? path.resolve(p.state)
    : buildDefaultStatePath({ accounts: p.accounts, query: p.query })

  // Dispatch accounts by platform prefix
  let gmailAccounts: string[] = []
  let slackAccounts: string[] = []
  for (let account of p.accounts) {
    if (account.startsWith("slack:")) slackAccounts.push(account.slice("slack:".length))
    else gmailAccounts.push(account)
  }

  let sources: Array<{ source: MessageSource; accounts: string[] }> = []
  if (gmailAccounts.length) sources.push({ source: gmailMail.gmailSource, accounts: gmailAccounts })
  if (slackAccounts.length) sources.push({ source: slackMail.slackSource, accounts: slackAccounts })

  let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
    if (msg.platform === "slack") return slackMail.markSlackRead(msg, account)
    return gmailMail.markGmailRead(msg, account)
  }

  // Collect messages into an array instead of writing to stdout
  let messages: UnifiedMessage[] = []
  let sink = {
    async write(msg: UnifiedMessage) {
      messages.push(msg)
    },
  }

  let result = await ingestOnce({
    sources,
    query: p.query,
    maxResults: p.maxResults,
    sink,
    statePath,
    markRead: resolveMarkRead,
    doMarkRead: p.markRead,
    seed: p.seed,
    verbose: false,
  })

  return {
    status: 200,
    data: { ...result, messages },
  }
}

// ---------------------------------------------------------------------------
// Send filtering
// ---------------------------------------------------------------------------

let filterGmailRecipients = (addresses: string[], allowList: string[]): string[] => {
  if (allowList.length === 0) return addresses
  let allowed = new Set(allowList.map(a => a.toLowerCase()))
  return addresses.filter(addr => {
    // Extract email from "Name <email>" format
    let match = addr.match(/<([^>]+)>/)
    let email = (match ? match[1] : addr).toLowerCase().trim()
    return allowed.has(email)
  })
}

let isSlackChannelAllowed = (channel: string, allowList: string[]): boolean => {
  if (allowList.length === 0) return true
  let normalized = channel.replace(/^#/, "").toLowerCase()
  return allowList.some(c => c.replace(/^#/, "").toLowerCase() === normalized)
}

// ---------------------------------------------------------------------------
// Send rate limiter (fixed-window, per-minute)
// ---------------------------------------------------------------------------

let createRateLimiter = (maxPerMinute: number) => {
  let windowStart = Date.now()
  let count = 0

  return {
    check(): { allowed: true } | { allowed: false; retryAfterMs: number } {
      if (maxPerMinute <= 0) return { allowed: true }
      let now = Date.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        count = 0
      }
      if (count >= maxPerMinute) {
        let retryAfterMs = 60_000 - (now - windowStart)
        return { allowed: false, retryAfterMs }
      }
      count += 1
      return { allowed: true }
    },
  }
}

// ---------------------------------------------------------------------------
// Draft handlers
// ---------------------------------------------------------------------------

let handleDraftCompose = async (body: unknown) => {
  let v = validate(DraftComposeRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let now = new Date().toISOString()
  let draft: Draft = { ...p, id: generateDraftId(), createdAt: now, updatedAt: now } as Draft
  saveDraft(p.workspaceId, draft)
  return { status: 200, data: draft }
}

let handleDraftList = async (body: unknown) => {
  let v = validate(DraftListRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let drafts = listDrafts(v.data.workspaceId, v.data.platform)
  return { status: 200, data: { drafts } }
}

let handleDraftShow = async (body: unknown) => {
  let v = validate(DraftIdParam, body)
  if (!v.success) return { status: 400, error: v.error }
  try {
    let draft = loadDraft(v.data.workspaceId, v.data.id)
    return { status: 200, data: draft }
  } catch (e) {
    return { status: 404, error: (e as Error).message }
  }
}

let handleDraftUpdate = async (body: unknown) => {
  let v = validate(DraftUpdateRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data
  let draft: Draft
  try {
    draft = loadDraft(p.workspaceId, p.id)
  } catch (e) {
    return { status: 404, error: (e as Error).message }
  }

  if (p.label !== undefined) draft.label = p.label
  if (p.attachments !== undefined) draft.attachments = p.attachments

  if (draft.platform === "gmail") {
    if (p.to !== undefined) draft.to = p.to
    if (p.cc !== undefined) draft.cc = p.cc
    if (p.bcc !== undefined) draft.bcc = p.bcc
    if (p.subject !== undefined) draft.subject = p.subject
    if (p.body !== undefined) draft.body = p.body
    if (p.from !== undefined) draft.from = p.from
    if (p.threadId !== undefined) draft.threadId = p.threadId
    if (p.inReplyTo !== undefined) draft.inReplyTo = p.inReplyTo
    if (p.references !== undefined) draft.references = p.references
  } else if (draft.platform === "slack") {
    if (p.channel !== undefined) draft.channel = p.channel
    if (p.text !== undefined) draft.text = p.text
    if (p.threadTs !== undefined) draft.threadTs = p.threadTs
  }

  draft.updatedAt = new Date().toISOString()
  saveDraft(p.workspaceId, draft)
  return { status: 200, data: draft }
}

let handleDraftDelete = async (body: unknown) => {
  let v = validate(DraftIdParam, body)
  if (!v.success) return { status: 400, error: v.error }
  try {
    deleteDraft(v.data.workspaceId, v.data.id)
    return { status: 200, data: { deleted: true, id: v.data.id } }
  } catch (e) {
    return { status: 404, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Route table (built per server instance to close over opts)
// ---------------------------------------------------------------------------

type Handler = (body: unknown) => Promise<{ status: number; data?: unknown; error?: string }>
export type Capability =
  | "read"
  | "ingest"
  | "drafts"
  | "send"
  | "workspace_read"
  | "workspace_write"
  | "workspace_actions"
  | "all"

export type TokenSpec = {
  token: string
  capabilities: Capability[]
}

type RouteDef = {
  handler: Handler
  capabilities: Capability[]
}

let packageVersion = () => {
  try {
    let serverDir = path.dirname(fileURLToPath(import.meta.url))
    let packagePath = path.resolve(serverDir, "..", "..", "package.json")
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

let routeCatalog = () => ([
  { method: "GET", path: "/.well-known/llms.txt", auth: "none", purpose: "Human-readable agent bootstrap instructions" },
  { method: "GET", path: "/api/agent/manifest", auth: "valid token", purpose: "Structured agent bootstrap manifest" },
  { method: "GET", path: "/api/health", auth: "read", purpose: "Health check" },
  { method: "POST", path: "/api/workspace/export", auth: "workspace_read", purpose: "Export agent-safe workspace snapshot or bundle" },
  { method: "POST", path: "/api/workspace/bootstrap", auth: "workspace_write", purpose: "Create a server workspace" },
  { method: "POST", path: "/api/workspace/import", auth: "workspace_write", purpose: "Import a workspace bundle" },
  { method: "POST", path: "/api/workspace/pull", auth: "ingest", purpose: "Pull messages into messages/" },
  { method: "POST", path: "/api/workspace/push", auth: "workspace_write", purpose: "Push bounded writable file edits" },
  { method: "POST", path: "/api/workspace/actions", auth: "workspace_actions", purpose: "Apply privileged workspace actions" },
  { method: "POST", path: "/api/draft/compose", auth: "drafts", purpose: "Create a workspace-owned draft" },
  { method: "POST", path: "/api/draft/list", auth: "drafts", purpose: "List workspace drafts" },
  { method: "POST", path: "/api/draft/show", auth: "drafts", purpose: "Show a workspace draft" },
  { method: "POST", path: "/api/draft/update", auth: "drafts", purpose: "Update a workspace draft" },
  { method: "POST", path: "/api/draft/send", auth: "send", purpose: "Send a draft through policy checks" },
  { method: "POST", path: "/api/draft/delete", auth: "drafts", purpose: "Delete a workspace draft" },
  { method: "POST", path: "/api/gmail/search", auth: "read", purpose: "Search Gmail" },
  { method: "POST", path: "/api/gmail/thread", auth: "read", purpose: "Fetch full Gmail thread context" },
  { method: "POST", path: "/api/gmail/read", auth: "read", purpose: "Read a Gmail message" },
  { method: "POST", path: "/api/gmail/send", auth: "send", purpose: "Send Gmail" },
  { method: "POST", path: "/api/gmail/mark-read", auth: "send", purpose: "Mark Gmail message read" },
  { method: "POST", path: "/api/gmail/archive", auth: "send", purpose: "Archive Gmail message" },
  { method: "POST", path: "/api/slack/search", auth: "read", purpose: "Search Slack" },
  { method: "POST", path: "/api/slack/read", auth: "read", purpose: "Read a Slack message" },
  { method: "POST", path: "/api/slack/send", auth: "send", purpose: "Send Slack message" },
  { method: "POST", path: "/api/ingest", auth: "ingest", purpose: "One-shot ingest across accounts" },
]) as const

let buildLlmsText = (opts: ServeOptions) => [
  "# msgmon serve",
  "",
  "msgmon serve is a privileged message-control server. It holds credentials,",
  "enforces policy, and exposes an agent-safe file mirror model over HTTP.",
  "",
  "Trust model:",
  "- The server is trusted and keeps OAuth tokens plus outbound policy.",
  "- The agent is untrusted or semi-trusted and should work from exported files.",
  "- The agent must send privileged actions back through the API.",
  "",
  "Bootstrap flow:",
  "1. Read this file.",
  "2. Call GET /api/agent/manifest with X-Auth-Token.",
  "3. Call POST /api/workspace/export to materialize a local workspace mirror.",
  "4. Edit only writable files such as AGENTS.md, status.md, and drafts/.",
  "5. Send local changes back with POST /api/workspace/push.",
  "6. Request privileged actions through POST /api/workspace/actions or the send endpoints.",
  "",
  "Auth:",
  "- Header: X-Auth-Token: <token>",
  "- Tokens may be capability-scoped.",
  "",
  `Host: http://${opts.host}:${opts.port}`,
  "Manifest: /api/agent/manifest",
  "",
  "Key endpoints:",
  ...routeCatalog().map(route => `- ${route.method} ${route.path} — ${route.purpose}`),
  "",
  "Recommended agent behavior:",
  "- Never send without explicit user approval.",
  "- Treat workspace.json and messages/ as read-only.",
  "- Use polling rather than assuming push transport.",
].join("\n")

let buildAgentManifest = (tokenSpec: TokenSpec) => ({
  name: "msgmon serve",
  version: packageVersion(),
  protocolVersion: "msgmon.agent.v1",
  description: "Privileged message-control plane with an agent-safe file mirror.",
  auth: {
    header: "X-Auth-Token",
    tokenCapabilities: tokenSpec.capabilities,
  },
  recommendedPollingIntervalMs: 5000,
  workspaceSync: {
    exportRoute: "/api/workspace/export",
    pushRoute: "/api/workspace/push",
    bootstrapRoute: "/api/workspace/bootstrap",
    importRoute: "/api/workspace/import",
    pullRoute: "/api/workspace/pull",
    writablePaths: ["AGENTS.md", "status.md", "drafts/**"],
    readOnlyPaths: ["workspace.json", "messages/**"],
  },
  workflows: [
    "Pull a workspace snapshot into an isolated local directory.",
    "Read messages/ and update status.md.",
    "Create or revise drafts under drafts/ as flat json files.",
    "Push bounded local changes back to the server.",
    "Ask for user approval before any send/archive/mark-read action.",
  ],
  routes: routeCatalog(),
})

let buildRoutes = (opts: ServeOptions): Record<string, RouteDef> => {
  let rateLimiter = createRateLimiter(opts.sendRateLimit)

  let guardedGmailSend: Handler = async (body) => {
    let v = validate(GmailSendRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    let p = v.data

    // Rate limit
    let rl = rateLimiter.check()
    if (!rl.allowed) {
      return { status: 429, error: `Rate limit exceeded (${opts.sendRateLimit}/min). Retry after ${Math.ceil(rl.retryAfterMs / 1000)}s.` }
    }

    // Filter recipients
    let to = filterGmailRecipients([p.to], opts.gmailAllowTo)
    let cc = filterGmailRecipients(p.cc, opts.gmailAllowTo)
    let bcc = filterGmailRecipients(p.bcc, opts.gmailAllowTo)

    if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
      return { status: 400, error: "No allowed recipients remain after filtering. Check --gmail-allow-to." }
    }
    let [{ buildRawMessage, base64url }, { gmailClient }] = await Promise.all([
      import("../../platforms/gmail/mail"),
      import("../../platforms/gmail/MailSource"),
    ])

    let raw = buildRawMessage({
      from: p.from,
      to: to[0] ?? "",
      cc,
      bcc,
      replyTo: p.replyTo,
      inReplyTo: p.inReplyTo,
      references: p.references,
      messageId: p.messageId,
      subject: p.subject,
      body: p.body,
      attach: p.attachments,
    })

    let client = gmailClient(p.account)
    let r = await client.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64url(raw),
        ...(p.threadId ? { threadId: p.threadId } : {}),
      },
    })
    return { status: 200, data: r.data }
  }

  let guardedSlackSend: Handler = async (body) => {
    let v = validate(SlackSendRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    let p = v.data

    // Rate limit
    let rl = rateLimiter.check()
    if (!rl.allowed) {
      return { status: 429, error: `Rate limit exceeded (${opts.sendRateLimit}/min). Retry after ${Math.ceil(rl.retryAfterMs / 1000)}s.` }
    }

    // Channel allowlist
    if (!isSlackChannelAllowed(p.channel, opts.slackAllowChannels)) {
      return { status: 400, error: `Channel "${p.channel}" is not in --slack-allow-channels.` }
    }
    let { slackClients, slackReadClient, uploadFilesToChannel, postMessageWithJoinFallback } = await import("../../platforms/slack/slackClient")

    let clients = slackClients(p.account)
    let reader = slackReadClient(clients)
    let sendClient = p.asUser && clients.user ? clients.user : clients.bot

    let channelId = p.channel
    if (channelId.startsWith("#")) {
      let r = await reader.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
      })
      let match = (r.channels ?? []).find(c => c.name === channelId.replace(/^#/, ""))
      if (!match?.id) return { status: 404, error: `Channel "${channelId}" not found` }
      channelId = match.id
    }

    // Send text message if present
    let messageResult: { ok?: boolean; ts?: string; channel?: string } | null = null
    if (p.text) {
      let r = await postMessageWithJoinFallback({
        clients,
        sendClient,
        channelId,
        text: p.text,
        threadTs: p.threadTs,
      })
      messageResult = { ok: r.ok, ts: r.ts, channel: r.channel }
    }

    // Upload attachments if present
    let filesUploaded = 0
    if (p.attachments.length > 0) {
      let files = p.attachments.map(a => ({
        filename: a.filename,
        data: Buffer.from(a.data, "base64"),
      }))
      await uploadFilesToChannel(sendClient, channelId, files, {
        threadTs: p.threadTs ?? messageResult?.ts,
        initialComment: messageResult ? undefined : p.text,
      })
      filesUploaded = files.length
    }

    return {
      status: 200,
      data: {
        ok: messageResult?.ok ?? true,
        ts: messageResult?.ts,
        channel: messageResult?.channel ?? channelId,
        filesUploaded,
      },
    }
  }

  let guardedDraftSend: Handler = async (body) => {
    let v = validate(DraftSendRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    let p = v.data

    let draft: Draft
    try {
      draft = loadDraft(p.workspaceId, p.id)
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }

    // Rate limit
    let rl = rateLimiter.check()
    if (!rl.allowed) {
      return { status: 429, error: `Rate limit exceeded (${opts.sendRateLimit}/min). Retry after ${Math.ceil(rl.retryAfterMs / 1000)}s.` }
    }

    // Apply send filtering
    if (draft.platform === "gmail") {
      let to = filterGmailRecipients([draft.to], opts.gmailAllowTo)
      let cc = filterGmailRecipients(draft.cc, opts.gmailAllowTo)
      let bcc = filterGmailRecipients(draft.bcc, opts.gmailAllowTo)
      if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
        return { status: 400, error: "No allowed recipients remain after filtering. Check --gmail-allow-to." }
      }
    } else if (draft.platform === "slack") {
      if (!isSlackChannelAllowed(draft.channel, opts.slackAllowChannels)) {
        return { status: 400, error: `Channel "${draft.channel}" is not in --slack-allow-channels.` }
      }
    }

    try {
      let { sendDraft } = await import("../draft/send")
      let result = await sendDraft(draft)
      if (!p.keep) deleteDraft(p.workspaceId, draft.id)
      return { status: 200, data: { sent: true, draftId: draft.id, deleted: !p.keep, result } }
    } catch (e) {
      return { status: 500, error: (e as Error).message }
    }
  }

  let workspaceHandlers = createWorkspaceHandlers(opts)
  return {
    "POST /api/gmail/search": { handler: handleGmailSearch, capabilities: ["read"] },
    "POST /api/gmail/count": { handler: handleGmailCount, capabilities: ["read"] },
    "POST /api/gmail/thread": { handler: handleGmailThread, capabilities: ["read"] },
    "POST /api/gmail/read": { handler: handleGmailRead, capabilities: ["read"] },
    "POST /api/gmail/send": { handler: guardedGmailSend, capabilities: ["send"] },
    "POST /api/gmail/mark-read": { handler: handleGmailMarkRead, capabilities: ["send"] },
    "POST /api/gmail/archive": { handler: handleGmailArchive, capabilities: ["send"] },
    "POST /api/gmail/accounts": { handler: handleGmailAccounts, capabilities: ["read"] },
    "POST /api/slack/search": { handler: handleSlackSearch, capabilities: ["read"] },
    "POST /api/slack/read": { handler: handleSlackRead, capabilities: ["read"] },
    "POST /api/slack/send": { handler: guardedSlackSend, capabilities: ["send"] },
    "POST /api/slack/accounts": { handler: handleSlackAccounts, capabilities: ["read"] },
    "POST /api/ingest": { handler: handleIngest, capabilities: ["ingest"] },
    "POST /api/draft/compose": { handler: handleDraftCompose, capabilities: ["drafts"] },
    "POST /api/draft/list": { handler: handleDraftList, capabilities: ["drafts"] },
    "POST /api/draft/show": { handler: handleDraftShow, capabilities: ["drafts"] },
    "POST /api/draft/update": { handler: handleDraftUpdate, capabilities: ["drafts"] },
    "POST /api/draft/send": { handler: guardedDraftSend, capabilities: ["send"] },
    "POST /api/draft/delete": { handler: handleDraftDelete, capabilities: ["drafts"] },
    "POST /api/workspace/export": { handler: workspaceHandlers["POST /api/workspace/export"], capabilities: ["workspace_read"] },
    "POST /api/workspace/bootstrap": { handler: workspaceHandlers["POST /api/workspace/bootstrap"], capabilities: ["workspace_write"] },
    "POST /api/workspace/import": { handler: workspaceHandlers["POST /api/workspace/import"], capabilities: ["workspace_write"] },
    "POST /api/workspace/pull": { handler: workspaceHandlers["POST /api/workspace/pull"], capabilities: ["ingest"] },
    "POST /api/workspace/push": { handler: workspaceHandlers["POST /api/workspace/push"], capabilities: ["workspace_write"] },
    "POST /api/workspace/actions": { handler: workspaceHandlers["POST /api/workspace/actions"], capabilities: ["workspace_actions"] },
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export type ServeOptions = {
  port: number
  tokens: TokenSpec[]
  host: string
  verbose: boolean
  gmailAllowTo: string[]
  slackAllowChannels: string[]
  sendRateLimit: number
}

let hasCapabilities = (tokenSpec: TokenSpec, required: Capability[]) =>
  tokenSpec.capabilities.includes("all") || required.every(cap => tokenSpec.capabilities.includes(cap))

export let createServer = (opts: ServeOptions) => {
  let routes = buildRoutes(opts)
  let llmsText = buildLlmsText(opts)

  let server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
        "Access-Control-Max-Age": "86400",
      })
      res.end()
      return
    }

    // Route lookup
    let routeKey = `${req.method} ${req.url}`
    let route = routes[routeKey]

    if (!route) {
      if (req.method === "GET" && req.url === "/.well-known/llms.txt") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(llmsText),
        })
        res.end(llmsText)
        return
      }
      if (req.method === "GET" && req.url === "/api/agent/manifest") {
        let authToken = req.headers["x-auth-token"]
        let tokenSpec = typeof authToken === "string"
          ? opts.tokens.find(token => token.token === authToken)
          : undefined
        if (!tokenSpec) {
          fail(res, 401, "Unauthorized: invalid or missing X-Auth-Token header")
          return
        }
        ok(res, buildAgentManifest(tokenSpec))
        return
      }
      // Try GET /api/health as a special case (no body needed)
      if (req.method === "GET" && req.url === "/api/health") {
        let authToken = req.headers["x-auth-token"]
        let tokenSpec = typeof authToken === "string"
          ? opts.tokens.find(token => token.token === authToken)
          : undefined
        if (!tokenSpec || !hasCapabilities(tokenSpec, ["read"])) {
          fail(res, 401, "Unauthorized: invalid or missing X-Auth-Token header")
          return
        }
        ok(res, { status: "ok", uptime: process.uptime() })
        return
      }
      fail(res, 404, `Unknown route: ${req.method} ${req.url}`)
      return
    }

    let authToken = req.headers["x-auth-token"]
    let tokenSpec = typeof authToken === "string"
      ? opts.tokens.find(token => token.token === authToken)
      : undefined
    if (!tokenSpec) {
      fail(res, 401, "Unauthorized: invalid or missing X-Auth-Token header")
      return
    }
    if (!hasCapabilities(tokenSpec, route.capabilities)) {
      fail(res, 403, `Forbidden: token lacks required capabilities (${route.capabilities.join(", ")})`)
      return
    }

    try {
      let body = await parseBody(req)
      verboseLog(opts.verbose, "request", { method: req.method, url: req.url })
      let result = await route.handler(body)
      if (result.error) {
        fail(res, result.status, result.error)
      } else {
        ok(res, result.data)
      }
    } catch (err: unknown) {
      let message = err instanceof Error ? err.message : String(err)
      verboseLog(opts.verbose, "handler error", { url: req.url, error: message })
      fail(res, 500, message)
    }
  })

  return server
}

export let startServer = (opts: ServeOptions) =>
  new Promise<http.Server>((resolve, reject) => {
    let server = createServer(opts)
    server.on("error", reject)
    server.listen(opts.port, opts.host, () => {
      console.log(`[msgmon] server listening on http://${opts.host}:${opts.port}`)
      console.log(`[msgmon] 25 routes registered`)
      console.log(`[msgmon] auth tokens: ${opts.tokens.length}`)
      if (opts.gmailAllowTo.length) console.log(`[msgmon] gmail-allow-to: ${opts.gmailAllowTo.join(", ")}`)
      if (opts.slackAllowChannels.length) console.log(`[msgmon] slack-allow-channels: ${opts.slackAllowChannels.join(", ")}`)
      if (opts.sendRateLimit > 0) console.log(`[msgmon] send-rate-limit: ${opts.sendRateLimit}/min`)
      resolve(server)
    })
  })

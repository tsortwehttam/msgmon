import http from "node:http"
import path from "node:path"
import { z } from "zod"
import { google } from "googleapis"
import { gmailClient } from "../../platforms/gmail/MailSource"
import { toUnifiedMessage } from "../../platforms/gmail/toUnifiedMessage"
import { headerMap, pickBody } from "../../platforms/gmail/MessageExport"
import { base64url, buildRawMessage } from "../../platforms/gmail/mail"
import { listAccounts as listGmailAccounts } from "../../platforms/gmail/accounts"
import { slackClients, uploadFilesToChannel } from "../../platforms/slack/slackClient"
import { toUnifiedMessage as slackToUnifiedMessage } from "../../platforms/slack/toUnifiedMessage"
import type { SlackMessage, UserCache } from "../../platforms/slack/toUnifiedMessage"
import { listSlackAccounts } from "../../platforms/slack/accounts"
import { ingestOnce, buildDefaultStatePath } from "../ingest/ingest"
import { createNdjsonSink } from "../ingest/sinks"
import { gmailSource, markGmailRead } from "../../platforms/gmail/MailSource"
import { slackSource, markSlackRead } from "../../platforms/slack/SlackSource"
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
  AccountParam,
  type ApiResponse,
} from "./schema"

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

  let client = gmailClient(p.account)
  let r = await client.users.messages.get({ userId: "me", id: p.messageId, format: "full" })
  return { status: 200, data: toUnifiedMessage(r.data) }
}

let handleGmailMarkRead = async (body: unknown) => {
  let v = validate(GmailModifyRequest, body)
  if (!v.success) return { status: 400, error: v.error }
  let p = v.data

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

  let client = gmailClient(p.account)
  let r = await client.users.messages.modify({
    userId: "me",
    id: p.messageId,
    requestBody: { removeLabelIds: ["INBOX"] },
  })
  return { status: 200, data: r.data }
}

let handleGmailAccounts = async (body: unknown) => {
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

  let clients = slackClients(p.account)
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

  let clients = slackClients(p.account)

  // Resolve channel name to ID
  let channelId = p.channel
  let channelName = p.channel
  if (channelId.startsWith("#")) {
    let r = await clients.bot.conversations.list({
      types: "public_channel,private_channel",
      limit: 1000,
    })
    let match = (r.channels ?? []).find(c => c.name === channelId.replace(/^#/, ""))
    if (!match?.id) return { status: 404, error: `Channel "${channelId}" not found` }
    channelName = match.name ?? channelId
    channelId = match.id
  }

  let r = await clients.bot.conversations.history({
    channel: channelId,
    latest: p.ts,
    inclusive: true,
    limit: 1,
  })
  let msg = (r.messages ?? [])[0]
  if (!msg) return { status: 404, error: `No message found at ${channelId}:${p.ts}` }

  let userCache: UserCache = new Map()
  if (msg.user) {
    try {
      let u = await clients.bot.users.info({ user: msg.user })
      let name = u.user?.profile?.display_name || u.user?.profile?.real_name || u.user?.name
      if (name) userCache.set(msg.user, name)
    } catch { /* proceed without name */ }
  }

  let unified = slackToUnifiedMessage(msg as SlackMessage, {
    channelId,
    channelName,
    teamId: clients.teamId ?? "",
    userCache,
  })
  return { status: 200, data: unified }
}

let handleSlackAccounts = async (body: unknown) => {
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
  if (gmailAccounts.length) sources.push({ source: gmailSource, accounts: gmailAccounts })
  if (slackAccounts.length) sources.push({ source: slackSource, accounts: slackAccounts })

  let resolveMarkRead = (msg: UnifiedMessage, account: string) => {
    if (msg.platform === "slack") return markSlackRead(msg, account)
    return markGmailRead(msg, account)
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
// Route table (built per server instance to close over opts)
// ---------------------------------------------------------------------------

type Handler = (body: unknown) => Promise<{ status: number; data?: unknown; error?: string }>

let buildRoutes = (opts: ServeOptions): Record<string, Handler> => {
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

    let clients = slackClients(p.account)
    let sendClient = p.asUser && clients.user ? clients.user : clients.bot

    let channelId = p.channel
    if (channelId.startsWith("#")) {
      let r = await clients.bot.conversations.list({
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
      let r = await sendClient.chat.postMessage({
        channel: channelId,
        text: p.text,
        thread_ts: p.threadTs,
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

  return {
    "POST /api/gmail/search": handleGmailSearch,
    "POST /api/gmail/count": handleGmailCount,
    "POST /api/gmail/thread": handleGmailThread,
    "POST /api/gmail/read": handleGmailRead,
    "POST /api/gmail/send": guardedGmailSend,
    "POST /api/gmail/mark-read": handleGmailMarkRead,
    "POST /api/gmail/archive": handleGmailArchive,
    "POST /api/gmail/accounts": handleGmailAccounts,
    "POST /api/slack/search": handleSlackSearch,
    "POST /api/slack/read": handleSlackRead,
    "POST /api/slack/send": guardedSlackSend,
    "POST /api/slack/accounts": handleSlackAccounts,
    "POST /api/ingest": handleIngest,
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export type ServeOptions = {
  port: number
  token: string
  host: string
  verbose: boolean
  gmailAllowTo: string[]
  slackAllowChannels: string[]
  sendRateLimit: number
}

export let createServer = (opts: ServeOptions) => {
  let routes = buildRoutes(opts)

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

    // Auth check
    let authToken = req.headers["x-auth-token"]
    if (authToken !== opts.token) {
      fail(res, 401, "Unauthorized: invalid or missing X-Auth-Token header")
      return
    }

    // Route lookup
    let routeKey = `${req.method} ${req.url}`
    let handler = routes[routeKey]

    if (!handler) {
      // Try GET /api/health as a special case (no body needed)
      if (req.method === "GET" && req.url === "/api/health") {
        ok(res, { status: "ok", uptime: process.uptime() })
        return
      }
      fail(res, 404, `Unknown route: ${req.method} ${req.url}`)
      return
    }

    try {
      let body = await parseBody(req)
      verboseLog(opts.verbose, "request", { method: req.method, url: req.url })
      let result = await handler(body)
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
      console.log(`[msgmon] 13 routes registered`)
      if (opts.gmailAllowTo.length) console.log(`[msgmon] gmail-allow-to: ${opts.gmailAllowTo.join(", ")}`)
      if (opts.slackAllowChannels.length) console.log(`[msgmon] slack-allow-channels: ${opts.slackAllowChannels.join(", ")}`)
      if (opts.sendRateLimit > 0) console.log(`[msgmon] send-rate-limit: ${opts.sendRateLimit}/min`)
      resolve(server)
    })
  })

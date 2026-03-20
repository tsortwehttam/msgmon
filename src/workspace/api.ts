import type { Draft } from "../draft/schema"
import {
  WorkspaceExportRequest,
  WorkspaceRefreshRequest,
  WorkspaceBootstrapRequest,
  WorkspaceImportRequest,
  WorkspacePushRequest,
  WorkspaceActionRequest,
} from "../serve/schema"
import {
  initWorkspace,
  exportWorkspaceSnapshot,
  exportWorkspaceBundle,
  applyWorkspacePush,
  importWorkspaceBundle,
} from "./store"
import { loadDraft, deleteDraft } from "../draft/store"

export type WorkspaceHandler = (body: unknown) => Promise<{ status: number; data?: unknown; error?: string }>

export type WorkspaceApiOptions = {
  gmailAllowTo: string[]
  slackAllowChannels: string[]
  sendRateLimit: number
}

let filterGmailRecipients = (addresses: string[], allowList: string[]): string[] => {
  if (allowList.length === 0) return addresses
  let allowed = new Set(allowList.map(a => a.toLowerCase()))
  return addresses.filter(addr => {
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
        return { allowed: false, retryAfterMs: 60_000 - (now - windowStart) }
      }
      count += 1
      return { allowed: true }
    },
  }
}

let validateBody = <T>(schema: {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}, body: unknown): { success: true; data: T } | { success: false; error: string } => {
  let result = schema.safeParse(body)
  if (!result.success) {
    let issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { success: false, error: `Validation failed: ${issues}` }
  }
  return { success: true, data: result.data }
}

export let createWorkspaceHandlers = (opts: WorkspaceApiOptions): Record<string, WorkspaceHandler> => {
  let rateLimiter = createRateLimiter(opts.sendRateLimit)

  let handleWorkspaceExport: WorkspaceHandler = async body => {
    let v = validateBody(WorkspaceExportRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    if (v.data.format === "bundle") return { status: 200, data: exportWorkspaceBundle(v.data.workspaceId) }
    return { status: 200, data: exportWorkspaceSnapshot(v.data.workspaceId) }
  }

  let handleWorkspaceRefresh: WorkspaceHandler = async body => {
    let v = validateBody(WorkspaceRefreshRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    let p = v.data
    let { refreshWorkspace } = await import("./runtime")
    let result = await refreshWorkspace({
      workspaceId: p.workspaceId,
      maxResults: p.maxResults,
      markRead: p.markRead,
      saveAttachments: p.saveAttachments,
      seed: p.seed,
      verbose: false,
    })
    return { status: 200, data: { workspaceId: p.workspaceId, ...result } }
  }

  let handleWorkspacePush: WorkspaceHandler = async body => {
    let v = validateBody(WorkspacePushRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    try {
      let result = applyWorkspacePush(v.data.workspaceId, {
        baseRevision: v.data.baseRevision,
        files: v.data.files,
      })
      return { status: 200, data: result }
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err)
      return { status: message.includes("revision conflict") ? 409 : 400, error: message }
    }
  }

  let handleWorkspaceBootstrap: WorkspaceHandler = async body => {
    let v = validateBody(WorkspaceBootstrapRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    try {
      let result = initWorkspace(v.data.workspaceId, {
        name: v.data.name,
        accounts: v.data.accounts,
        query: v.data.query,
        overwrite: v.data.overwrite,
      })
      return { status: 200, data: { workspaceId: result.config.id, config: result.config, path: result.path } }
    } catch (err) {
      return { status: 400, error: err instanceof Error ? err.message : String(err) }
    }
  }

  let handleWorkspaceImport: WorkspaceHandler = async body => {
    let v = validateBody(WorkspaceImportRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    try {
      let result = importWorkspaceBundle({
        workspaceId: v.data.workspaceId,
        bundleBase64: v.data.bundleBase64,
        overwrite: v.data.overwrite,
      })
      return { status: 200, data: result }
    } catch (err) {
      return { status: 400, error: err instanceof Error ? err.message : String(err) }
    }
  }

  let handleWorkspaceActions: WorkspaceHandler = async body => {
    let v = validateBody(WorkspaceActionRequest, body)
    if (!v.success) return { status: 400, error: v.error }
    let p = v.data
    let results: unknown[] = []

    for (let action of p.actions) {
      if (action.type === "draft.delete") {
        try {
          deleteDraft(p.workspaceId, action.draftId)
          results.push({ type: action.type, draftId: action.draftId, deleted: true })
        } catch (err) {
          return { status: 404, error: err instanceof Error ? err.message : String(err) }
        }
        continue
      }

      if (action.type === "draft.send") {
        let rl = rateLimiter.check()
        if (!rl.allowed) {
          return { status: 429, error: `Rate limit exceeded (${opts.sendRateLimit}/min). Retry after ${Math.ceil(rl.retryAfterMs / 1000)}s.` }
        }

        let draft: Draft
        try {
          draft = loadDraft(p.workspaceId, action.draftId)
        } catch (err) {
          return { status: 404, error: err instanceof Error ? err.message : String(err) }
        }

        if (draft.platform === "gmail") {
          let to = filterGmailRecipients([draft.to], opts.gmailAllowTo)
          let cc = filterGmailRecipients(draft.cc, opts.gmailAllowTo)
          let bcc = filterGmailRecipients(draft.bcc, opts.gmailAllowTo)
          if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
            return { status: 400, error: "No allowed recipients remain after filtering. Check --gmail-allow-to." }
          }
          draft = { ...draft, to: to[0] ?? "", cc, bcc }
        }

        if (draft.platform === "slack" && !isSlackChannelAllowed(draft.channel, opts.slackAllowChannels)) {
          return { status: 400, error: `Channel "${draft.channel}" is not in --slack-allow-channels.` }
        }

        try {
          let { sendDraft } = await import("../draft/send")
          let result = await sendDraft(draft)
          if (!action.keep) deleteDraft(p.workspaceId, action.draftId)
          results.push({ type: action.type, draftId: action.draftId, sent: true, deleted: !action.keep, result })
        } catch (err) {
          return { status: 500, error: err instanceof Error ? err.message : String(err) }
        }
        continue
      }

      if (action.type === "message.mark_read.gmail") {
        try {
          let { markGmailRead } = await import("../../platforms/gmail/MailSource")
          await markGmailRead({
            id: action.messageId,
            platform: "gmail",
            timestamp: "",
            platformMetadata: { platform: "gmail", messageId: action.messageId },
          }, action.account)
          results.push({ type: action.type, messageId: action.messageId, markedRead: true })
        } catch (err) {
          return { status: 500, error: err instanceof Error ? err.message : String(err) }
        }
        continue
      }

      if (action.type === "message.mark_read.slack") {
        try {
          let { markSlackRead } = await import("../../platforms/slack/SlackSource")
          await markSlackRead({
            id: action.ts,
            platform: "slack",
            timestamp: "",
            platformMetadata: { platform: "slack", teamId: "", channelId: action.channelId, ts: action.ts },
          }, action.account)
          results.push({ type: action.type, channelId: action.channelId, ts: action.ts, markedRead: true })
        } catch (err) {
          return { status: 500, error: err instanceof Error ? err.message : String(err) }
        }
        continue
      }

      if (action.type === "message.archive") {
        try {
          let { gmailClient } = await import("../../platforms/gmail/MailSource")
          let client = gmailClient(action.account)
          let result = await client.users.messages.modify({
            userId: "me",
            id: action.messageId,
            requestBody: { removeLabelIds: ["INBOX"] },
          })
          results.push({ type: action.type, messageId: action.messageId, archived: true, result: result.data })
        } catch (err) {
          return { status: 500, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }

    return { status: 200, data: { workspaceId: p.workspaceId, results } }
  }

  return {
    "POST /api/workspace/export": handleWorkspaceExport,
    "POST /api/workspace/bootstrap": handleWorkspaceBootstrap,
    "POST /api/workspace/import": handleWorkspaceImport,
    "POST /api/workspace/refresh": handleWorkspaceRefresh,
    "POST /api/workspace/push": handleWorkspacePush,
    "POST /api/workspace/actions": handleWorkspaceActions,
  }
}

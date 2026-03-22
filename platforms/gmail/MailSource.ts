import fs from "node:fs"
import { google } from "googleapis"
import { resolveCredentialsPath, resolveTokenReadPathForAccount } from "../../src/CliConfig"
import type { MessageSource } from "../../src/ingest/ingest"
import type { UnifiedMessage } from "../../src/types"
import { toUnifiedMessage } from "./toUnifiedMessage"
import { collectAttachments } from "./MessageExport"
import { verboseLog } from "../../src/Verbose"

export let loadOAuth = (account: string, verbose = false) => {
  let credentialsPath = resolveCredentialsPath("gmail")
  let tokenPath = resolveTokenReadPathForAccount(account, "gmail")
  verboseLog(verbose, "mail auth", { account, credentialsPath, tokenPath })

  let raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
  let c = raw.installed ?? raw.web
  if (!c?.client_id || !c?.client_secret) throw new Error("Bad credentials.json (missing client_id/client_secret)")
  let o = new google.auth.OAuth2(c.client_id, c.client_secret, (c.redirect_uris ?? [])[0])
  let t = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
  o.setCredentials(t)
  return o
}

export let loadGmailProjectId = (): string | undefined => {
  try {
    let credentialsPath = resolveCredentialsPath("gmail")
    let raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
    let c = raw.installed ?? raw.web
    return c?.project_id
  } catch { return undefined }
}

export let gmailClient = (account: string, verbose = false) =>
  google.gmail({ version: "v1", auth: loadOAuth(account, verbose) })

let timestampMs = (value?: string) => {
  if (!value) return undefined
  let ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid time bound "${value}"`)
  return ms
}

export let gmailSource: MessageSource = {
  async *listMessages(params) {
    let client = gmailClient(params.account, params.verbose)
    let pageToken: string | undefined
    let oldest = timestampMs(params.oldest)
    let latest = timestampMs(params.latest)

    let yielded = 0
    while (true) {
      let response = await client.users.messages.list({
        userId: "me",
        q: params.query || undefined,
        maxResults: Math.min(params.maxResults - yielded, 100),
        pageToken,
      })

      let refs = (response.data.messages ?? []).filter(m => m.id)
      verboseLog(params.verbose, "mail page", {
        fetched: refs.length,
        nextPageToken: response.data.nextPageToken ?? null,
      })

      for (let ref of refs) {
        if (yielded >= params.maxResults) return
        let fetched = await client.users.messages.get({
          userId: "me",
          id: ref.id!,
          format: "full",
        })
        let unified = toUnifiedMessage(fetched.data)
        let messageTimestamp = timestampMs(unified.timestamp)
        if (oldest != null && messageTimestamp != null && messageTimestamp < oldest) continue
        if (latest != null && messageTimestamp != null && messageTimestamp > latest) continue
        yield unified
        yielded += 1
      }

      pageToken = response.data.nextPageToken ?? undefined
      if (!pageToken || yielded >= params.maxResults) break
    }
  },
}

/**
 * Mark a mail message as read by removing the UNREAD label.
 */
export let markGmailRead = async (msg: UnifiedMessage, account: string) => {
  if (msg.platformMetadata.platform !== "gmail") return
  let client = gmailClient(account)
  await client.users.messages.modify({
    userId: "me",
    id: msg.platformMetadata.messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  })
}

/**
 * Fetch attachment data for a mail message.
 */
export let fetchGmailAttachment = async (
  msg: UnifiedMessage,
  filename: string,
  account: string,
): Promise<Buffer | undefined> => {
  if (msg.platformMetadata.platform !== "gmail") return undefined
  let client = gmailClient(account)

  // Re-fetch the message to get attachment IDs
  let fetched = await client.users.messages.get({
    userId: "me",
    id: msg.platformMetadata.messageId,
    format: "full",
  })
  let attachments = collectAttachments(fetched.data.payload ?? undefined)
  let att = attachments.find(a => a.filename === filename)
  if (!att) return undefined

  let rawData = att.inlineData
  if (!rawData && att.attachmentId) {
    let fetched2 = await client.users.messages.attachments.get({
      userId: "me",
      messageId: msg.platformMetadata.messageId,
      id: att.attachmentId,
    })
    rawData = fetched2.data.data ?? undefined
  }
  if (!rawData) return undefined

  let normalized = rawData.replace(/-/g, "+").replace(/_/g, "/")
  let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, "base64")
}

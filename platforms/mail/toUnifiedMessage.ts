import type { gmail_v1 } from "googleapis"
import type { MailMetadata, Participant, UnifiedAttachment, UnifiedMessage } from "../../src/types"
import { collectAttachments, decodeBase64Url, headerMap, pickBody } from "./MessageExport"

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

let parseParticipant = (raw: string): Participant => {
  let match = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ""), address: match[2].trim() }
  return { address: raw.trim() }
}

let parseParticipants = (header?: string): Participant[] | undefined => {
  if (!header) return undefined
  return header
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseParticipant)
}

/**
 * Convert a Gmail API message payload into a UnifiedMessage.
 * The gmail message must have been fetched with format: "full" or "metadata".
 */
export let toUnifiedMessage = (msg: gmail_v1.Schema$Message): UnifiedMessage => {
  let headers = headerMap(msg)
  let body = pickBody(msg.payload ?? undefined)
  let bodyText = body.text ?? (body.html ? stripHtml(body.html) : undefined)
  let bodyHtml = body.html

  let attachmentParts = collectAttachments(msg.payload ?? undefined)
  let attachments: UnifiedAttachment[] | undefined =
    attachmentParts.length > 0
      ? attachmentParts.map(a => ({
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.inlineData ? Buffer.from(a.inlineData, "base64").length : undefined,
        }))
      : undefined

  let timestamp = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : headers.date
      ? new Date(headers.date).toISOString()
      : new Date().toISOString()

  let metadata: MailMetadata = {
    platform: "mail",
    messageId: msg.id ?? "",
    threadId: msg.threadId ?? undefined,
    rfc822MessageId: headers["message-id"],
    labelIds: msg.labelIds ?? undefined,
    headers,
  }

  return {
    id: msg.id ?? "",
    platform: "mail",
    timestamp,
    subject: headers.subject,
    bodyText,
    bodyHtml,
    from: headers.from ? parseParticipant(headers.from) : undefined,
    to: parseParticipants(headers.to),
    cc: parseParticipants(headers.cc),
    bcc: parseParticipants(headers.bcc),
    attachments,
    threadId: msg.threadId ?? undefined,
    platformMetadata: metadata,
  }
}

import fs from "node:fs"
import path from "node:path"
import type { gmail_v1 } from "googleapis"

export let decodeBase64Url = (value?: string) => {
  if (!value) return ""
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, "base64").toString("utf8")
}

export let headerMap = (msg: gmail_v1.Schema$Message) => {
  let out: Record<string, string> = {}
  for (let h of msg.payload?.headers ?? []) {
    if (!h.name || h.value == null) continue
    out[h.name.toLowerCase()] = h.value
  }
  return out
}

export let pickBody = (part?: gmail_v1.Schema$MessagePart): { text?: string; html?: string } => {
  if (!part) return {}
  if (part.mimeType === "text/plain") return { text: decodeBase64Url(part.body?.data ?? undefined) }
  if (part.mimeType === "text/html") return { html: decodeBase64Url(part.body?.data ?? undefined) }
  for (let child of part.parts ?? []) {
    let found = pickBody(child)
    if (found.text || found.html) return found
  }
  return {}
}

export type FoundAttachment = {
  filename: string
  mimeType?: string
  attachmentId?: string
  inlineData?: string
}

export let collectAttachments = (part?: gmail_v1.Schema$MessagePart, out: FoundAttachment[] = []) => {
  if (!part) return out
  if (part.filename) {
    out.push({
      filename: part.filename,
      mimeType: part.mimeType ?? undefined,
      attachmentId: part.body?.attachmentId ?? undefined,
      inlineData: part.body?.data ?? undefined,
    })
  }
  for (let child of part.parts ?? []) collectAttachments(child, out)
  return out
}

let sanitizeFileName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 200) || "file"

let uniquePath = (dir: string, baseName: string) => {
  let ext = path.extname(baseName)
  let name = path.basename(baseName, ext)
  let candidate = path.resolve(dir, baseName)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.resolve(dir, `${name}_${i}${ext}`)
    i += 1
  }
  return candidate
}

export let buildRunDirName = (messageId: string, subject?: string) => {
  let safeSubject = sanitizeFileName(subject ?? "no_subject")
  let stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return `${stamp}_${messageId}_${safeSubject}`
}

export let exportMessageArtifacts = async (params: {
  client: gmail_v1.Gmail
  messageId: string
  message: gmail_v1.Schema$Message
  outDir: string
}) => {
  let attachmentsDir = path.resolve(params.outDir, "attachments")
  fs.mkdirSync(attachmentsDir, { recursive: true })

  let headers = headerMap(params.message)
  fs.writeFileSync(path.resolve(params.outDir, "message.json"), `${JSON.stringify(params.message, null, 2)}\n`)
  fs.writeFileSync(path.resolve(params.outDir, "headers.json"), `${JSON.stringify(headers, null, 2)}\n`)

  let body = pickBody(params.message.payload ?? undefined)
  if (body.text) fs.writeFileSync(path.resolve(params.outDir, "body.txt"), body.text)
  if (body.html) fs.writeFileSync(path.resolve(params.outDir, "body.html"), body.html)
  if (!body.text && !body.html) fs.writeFileSync(path.resolve(params.outDir, "body.txt"), "")

  let attachmentCount = 0
  for (let att of collectAttachments(params.message.payload ?? undefined)) {
    let safeName = sanitizeFileName(att.filename)
    let outPath = uniquePath(attachmentsDir, safeName)
    let rawData = att.inlineData
    if (!rawData && att.attachmentId) {
      let fetched = await params.client.users.messages.attachments.get({
        userId: "me",
        messageId: params.messageId,
        id: att.attachmentId,
      })
      rawData = fetched.data.data ?? undefined
    }
    if (!rawData) continue
    let normalized = rawData.replace(/-/g, "+").replace(/_/g, "/")
    let padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
    fs.writeFileSync(outPath, Buffer.from(padded, "base64"))
    attachmentCount += 1
  }

  return {
    headers,
    body,
    attachmentCount,
  }
}

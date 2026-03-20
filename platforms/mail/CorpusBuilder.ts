import fs from "node:fs"
import path from "node:path"

type AttachmentRecord = {
  filename: string
  path: string
  sizeBytes: number
  textExtracted: boolean
  truncated: boolean
  text?: string
}

type MessageRecord = {
  type: "message"
  messageId: string
  threadId: string
  subject: string
  from: string
  to: string
  cc: string
  bcc: string
  date: string
  internalDate: string
  participants: string[]
  exportDir: string
  source: {
    messageJsonPath: string
    headersPath?: string
    bodyTextPath?: string
    bodyHtmlPath?: string
    attachmentsDir?: string
  }
  bodyText: string
  attachmentCount: number
  attachments: AttachmentRecord[]
  analysisText: string
  tokenEstimate: number
}

type ThreadMessageSummary = {
  messageId: string
  subject: string
  from: string
  date: string
  internalDate: string
  participants: string[]
  excerpt: string
}

let appendJsonl = (outPath: string, record: unknown) => {
  fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`)
}

let writeJson = (outPath: string, value: unknown) => {
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`)
}

let estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))

let normalizeWhitespace = (text: string) => text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()

let decodeHtmlEntities = (text: string) =>
  text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

let stripHtml = (html: string) => {
  let withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n\n")
    .replace(/<\s*\/div\s*>/gi, "\n")
    .replace(/<\s*\/li\s*>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
  let stripped = withBreaks.replace(/<[^>]+>/g, " ")
  return normalizeWhitespace(decodeHtmlEntities(stripped))
}

let readUtf8IfExists = (filePath: string) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined)

let readFilePrefix = (filePath: string, maxBytes: number) => {
  let fd = fs.openSync(filePath, "r")
  try {
    let stats = fs.fstatSync(fd)
    let length = Math.min(stats.size, maxBytes)
    let buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, 0)
    return {
      data: buffer,
      truncated: stats.size > maxBytes,
      sizeBytes: stats.size,
    }
  } finally {
    fs.closeSync(fd)
  }
}

let listMessageDirs = (rootDir: string) => {
  let out: string[] = []
  let stack = [path.resolve(rootDir)]
  while (stack.length > 0) {
    let current = stack.pop() as string
    let entries = fs.readdirSync(current, { withFileTypes: true })
    // Accept directories containing either unified.json (new ingest format) or message.json (legacy export)
    if (entries.some(entry => entry.isFile() && (entry.name === "unified.json" || entry.name === "message.json"))) {
      out.push(current)
      continue
    }
    for (let entry of entries) {
      if (!entry.isDirectory()) continue
      stack.push(path.resolve(current, entry.name))
    }
  }
  return out.sort()
}

let parseEmailAddresses = (...values: Array<string | undefined>) => {
  let matches = values
    .flatMap(value => value ?? "")
    .join(", ")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
  return Array.from(new Set((matches ?? []).map(value => value.toLowerCase())))
}

let extractAttachmentText = (filePath: string, maxBytes: number, maxChars: number): AttachmentRecord => {
  let ext = path.extname(filePath).toLowerCase()
  let prefix = readFilePrefix(filePath, maxBytes)
  let isTextLike = [".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm"].includes(ext)
  if (!isTextLike) {
    return {
      filename: path.basename(filePath),
      path: filePath,
      sizeBytes: prefix.sizeBytes,
      textExtracted: false,
      truncated: prefix.truncated,
    }
  }

  let raw = prefix.data.toString("utf8")
  let text = ext === ".html" || ext === ".htm" ? stripHtml(raw) : normalizeWhitespace(raw)
  let truncated = prefix.truncated || text.length > maxChars
  return {
    filename: path.basename(filePath),
    path: filePath,
    sizeBytes: prefix.sizeBytes,
    textExtracted: true,
    truncated,
    text: text.slice(0, maxChars),
  }
}

let excerpt = (text: string, maxChars: number) => text.replace(/\s+/g, " ").trim().slice(0, maxChars)

let chunkText = (text: string, maxChars: number, overlapChars: number) => {
  if (!text.trim()) return []
  let out: Array<{ text: string; charStart: number; charEnd: number }> = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    out.push({
      text: text.slice(start, end),
      charStart: start,
      charEnd: end,
    })
    if (end >= text.length) break
    start = Math.max(end - overlapChars, start + 1)
  }
  return out
}

let buildAnalysisText = (record: {
  subject: string
  from: string
  to: string
  cc: string
  bcc: string
  date: string
  participants: string[]
  bodyText: string
  attachments: AttachmentRecord[]
}) => {
  let parts = [
    `Subject: ${record.subject || "(no subject)"}`,
    `From: ${record.from || "(unknown)"}`,
    `To: ${record.to || "(none)"}`,
    ...(record.cc ? [`Cc: ${record.cc}`] : []),
    ...(record.bcc ? [`Bcc: ${record.bcc}`] : []),
    `Date: ${record.date || "(unknown)"}`,
    `Participants: ${record.participants.join(", ") || "(none)"}`,
    "",
    "Body:",
    record.bodyText || "(empty)",
  ]

  if (record.attachments.length > 0) {
    parts.push("", "Attachments:")
    for (let attachment of record.attachments) {
      parts.push(`- ${attachment.filename} (${attachment.sizeBytes} bytes)`)
      if (attachment.text) parts.push(attachment.text)
    }
  }

  return normalizeWhitespace(parts.join("\n"))
}

let sortTime = (value: ThreadMessageSummary) => {
  let parsed = Date.parse(value.internalDate || value.date)
  return Number.isFinite(parsed) ? parsed : 0
}

export let buildCorpus = (params: {
  exportDir: string
  outDir: string
  chunkChars: number
  chunkOverlapChars: number
  maxAttachmentBytes: number
  maxAttachmentChars: number
  threadExcerptChars: number
  verbose?: boolean
}) => {
  let exportDir = path.resolve(params.exportDir)
  let outDir = path.resolve(params.outDir)
  let messageDirs = listMessageDirs(exportDir)

  fs.mkdirSync(outDir, { recursive: true })
  let messagesJsonlPath = path.resolve(outDir, "messages.jsonl")
  let chunksJsonlPath = path.resolve(outDir, "chunks.jsonl")
  let threadsJsonlPath = path.resolve(outDir, "threads.jsonl")
  fs.writeFileSync(messagesJsonlPath, "")
  fs.writeFileSync(chunksJsonlPath, "")
  fs.writeFileSync(threadsJsonlPath, "")

  let threads = new Map<string, { participants: Set<string>; subjects: Set<string>; messages: ThreadMessageSummary[] }>()
  let totalAttachments = 0
  let totalChunks = 0

  for (let messageDir of messageDirs) {
    let unifiedJsonPath = path.resolve(messageDir, "unified.json")
    let messageJsonPath = path.resolve(messageDir, "message.json")
    let headersPath = path.resolve(messageDir, "headers.json")
    let bodyTextPath = path.resolve(messageDir, "body.txt")
    let bodyHtmlPath = path.resolve(messageDir, "body.html")
    let attachmentsDir = path.resolve(messageDir, "attachments")

    let messageId: string
    let threadId: string
    let subject: string
    let from: string
    let to: string
    let cc: string
    let bcc: string
    let date: string
    let internalDate: string

    if (fs.existsSync(unifiedJsonPath)) {
      // New unified format from ingest --sink=dir
      let unified = JSON.parse(fs.readFileSync(unifiedJsonPath, "utf8"))
      messageId = String(unified.id ?? path.basename(messageDir))
      threadId = String(unified.threadId ?? messageId)
      subject = String(unified.subject ?? "")
      from = unified.from ? (unified.from.name ? `${unified.from.name} <${unified.from.address}>` : unified.from.address) : ""
      to = (unified.to ?? []).map((p: { name?: string; address: string }) => p.name ? `${p.name} <${p.address}>` : p.address).join(", ")
      cc = (unified.cc ?? []).map((p: { name?: string; address: string }) => p.name ? `${p.name} <${p.address}>` : p.address).join(", ")
      bcc = (unified.bcc ?? []).map((p: { name?: string; address: string }) => p.name ? `${p.name} <${p.address}>` : p.address).join(", ")
      date = String(unified.timestamp ?? "")
      internalDate = date
    } else {
      // Legacy format from mail export
      let message = JSON.parse(fs.readFileSync(messageJsonPath, "utf8"))
      let headers = fs.existsSync(headersPath) ? JSON.parse(fs.readFileSync(headersPath, "utf8")) : {}
      messageId = String(message.id ?? path.basename(messageDir))
      threadId = String(message.threadId ?? messageId)
      subject = String(headers.subject ?? "")
      from = String(headers.from ?? "")
      to = String(headers.to ?? "")
      cc = String(headers.cc ?? "")
      bcc = String(headers.bcc ?? "")
      date = String(headers.date ?? "")
      internalDate = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : date
    }

    let bodyText = normalizeWhitespace(readUtf8IfExists(bodyTextPath) ?? stripHtml(readUtf8IfExists(bodyHtmlPath) ?? ""))
    let participants = parseEmailAddresses(from, to, cc, bcc)

    let attachments: AttachmentRecord[] = []
    if (fs.existsSync(attachmentsDir)) {
      for (let name of fs.readdirSync(attachmentsDir).sort()) {
        let attachmentPath = path.resolve(attachmentsDir, name)
        if (!fs.statSync(attachmentPath).isFile()) continue
        attachments.push(extractAttachmentText(attachmentPath, params.maxAttachmentBytes, params.maxAttachmentChars))
      }
    }
    totalAttachments += attachments.length

    let record: MessageRecord = {
      type: "message",
      messageId,
      threadId,
      subject,
      from,
      to,
      cc,
      bcc,
      date,
      internalDate,
      participants,
      exportDir: messageDir,
      source: {
        messageJsonPath,
        ...(fs.existsSync(headersPath) ? { headersPath } : {}),
        ...(fs.existsSync(bodyTextPath) ? { bodyTextPath } : {}),
        ...(fs.existsSync(bodyHtmlPath) ? { bodyHtmlPath } : {}),
        ...(fs.existsSync(attachmentsDir) ? { attachmentsDir } : {}),
      },
      bodyText,
      attachmentCount: attachments.length,
      attachments,
      analysisText: "",
      tokenEstimate: 0,
    }
    record.analysisText = buildAnalysisText(record)
    record.tokenEstimate = estimateTokens(record.analysisText)
    appendJsonl(messagesJsonlPath, record)

    let bodyChunks = chunkText(record.bodyText, params.chunkChars, params.chunkOverlapChars)
    for (let i = 0; i < bodyChunks.length; i++) {
      let chunk = bodyChunks[i]
      appendJsonl(chunksJsonlPath, {
        type: "chunk",
        chunkId: `${messageId}:body:${i + 1}`,
        messageId,
        threadId,
        source: "body",
        subject,
        from,
        date,
        participants,
        exportDir: messageDir,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        tokenEstimate: estimateTokens(chunk.text),
        text: chunk.text,
      })
      totalChunks += 1
    }

    for (let attachment of attachments) {
      if (!attachment.text) continue
      let attachmentChunks = chunkText(attachment.text, params.chunkChars, params.chunkOverlapChars)
      for (let i = 0; i < attachmentChunks.length; i++) {
        let chunk = attachmentChunks[i]
        appendJsonl(chunksJsonlPath, {
          type: "chunk",
          chunkId: `${messageId}:attachment:${attachment.filename}:${i + 1}`,
          messageId,
          threadId,
          source: `attachment:${attachment.filename}`,
          subject,
          from,
          date,
          participants,
          exportDir: messageDir,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          tokenEstimate: estimateTokens(chunk.text),
          text: chunk.text,
        })
        totalChunks += 1
      }
    }

    let thread = threads.get(threadId) ?? { participants: new Set<string>(), subjects: new Set<string>(), messages: [] }
    for (let participant of participants) thread.participants.add(participant)
    if (subject) thread.subjects.add(subject)
    thread.messages.push({
      messageId,
      subject,
      from,
      date,
      internalDate,
      participants,
      excerpt: excerpt(record.analysisText, params.threadExcerptChars),
    })
    threads.set(threadId, thread)
  }

  for (let [threadId, thread] of Array.from(threads.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    let ordered = thread.messages.sort((a, b) => sortTime(a) - sortTime(b))
    appendJsonl(threadsJsonlPath, {
      type: "thread",
      threadId,
      messageCount: ordered.length,
      participants: Array.from(thread.participants).sort(),
      subjects: Array.from(thread.subjects),
      startedAt: ordered[0]?.internalDate ?? ordered[0]?.date ?? "",
      endedAt: ordered[ordered.length - 1]?.internalDate ?? ordered[ordered.length - 1]?.date ?? "",
      messages: ordered,
    })
  }

  let summary = {
    builtAt: new Date().toISOString(),
    exportDir,
    outDir,
    messageCount: messageDirs.length,
    threadCount: threads.size,
    attachmentCount: totalAttachments,
    chunkCount: totalChunks,
    files: {
      messagesJsonlPath,
      chunksJsonlPath,
      threadsJsonlPath,
    },
  }
  writeJson(path.resolve(outDir, "summary.json"), summary)
  return summary
}

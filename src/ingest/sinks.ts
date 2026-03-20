import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import type { UnifiedMessage } from "../types"

// ---------------------------------------------------------------------------
// Sink interface
// ---------------------------------------------------------------------------

export type Sink = {
  write(msg: UnifiedMessage): Promise<void>
}

// ---------------------------------------------------------------------------
// NDJSON sink — one JSON line per message to a Writable (stdout or file)
// ---------------------------------------------------------------------------

export let createNdjsonSink = (params: {
  stream?: NodeJS.WritableStream
  filePath?: string
}): Sink => {
  let stream = params.stream
  let fd: number | undefined
  if (params.filePath) {
    fs.mkdirSync(path.dirname(params.filePath), { recursive: true })
    fd = fs.openSync(params.filePath, "a")
  }
  return {
    async write(msg) {
      let line = JSON.stringify(msg) + "\n"
      if (fd != null) fs.writeSync(fd, line)
      if (stream) stream.write(line)
    },
  }
}

// ---------------------------------------------------------------------------
// Dir sink — per-message scannable directory with unified.json + artifacts
// ---------------------------------------------------------------------------

let sanitizeFileName = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 200) || "file"

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

export let createDirSink = (params: {
  outDir: string
  saveAttachments?: boolean
  /** Called when attachment data is needed — platform adapter provides this */
  fetchAttachment?: (msg: UnifiedMessage, filename: string) => Promise<Buffer | undefined>
}): Sink => {
  fs.mkdirSync(params.outDir, { recursive: true })
  return {
    async write(msg) {
      let safeSubject = sanitizeFileName(msg.subject ?? "no_subject")
      let stamp = msg.timestamp.replace(/[:.]/g, "-")
      let dirName = `${stamp}_${msg.id}_${safeSubject}`
      let msgDir = path.resolve(params.outDir, dirName)
      fs.mkdirSync(msgDir, { recursive: true })

      // unified.json — the canonical output
      fs.writeFileSync(path.resolve(msgDir, "unified.json"), JSON.stringify(msg, null, 2) + "\n")

      // body.txt
      if (msg.bodyText) fs.writeFileSync(path.resolve(msgDir, "body.txt"), msg.bodyText)

      // body.html
      if (msg.bodyHtml) fs.writeFileSync(path.resolve(msgDir, "body.html"), msg.bodyHtml)

      // headers.json (for mail, extract from platformMetadata)
      if (msg.platformMetadata.platform === "mail" && msg.platformMetadata.headers) {
        fs.writeFileSync(
          path.resolve(msgDir, "headers.json"),
          JSON.stringify(msg.platformMetadata.headers, null, 2) + "\n",
        )
      }

      // attachments
      if (params.saveAttachments && msg.attachments && msg.attachments.length > 0) {
        let attDir = path.resolve(msgDir, "attachments")
        fs.mkdirSync(attDir, { recursive: true })
        for (let att of msg.attachments) {
          if (params.fetchAttachment) {
            let data = await params.fetchAttachment(msg, att.filename)
            if (data) {
              let outPath = uniquePath(attDir, sanitizeFileName(att.filename))
              fs.writeFileSync(outPath, data)
            }
          }
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Exec sink — run a shell command per message with env vars
// ---------------------------------------------------------------------------

export let createExecSink = (params: {
  command: string
  cwd?: string
}): Sink => ({
  async write(msg) {
    let env: Record<string, string> = {
      MESSAGEMON_ID: msg.id,
      MESSAGEMON_PLATFORM: msg.platform,
      MESSAGEMON_TIMESTAMP: msg.timestamp,
      MESSAGEMON_SUBJECT: msg.subject ?? "",
      MESSAGEMON_FROM: msg.from?.address ?? "",
      MESSAGEMON_THREAD_ID: msg.threadId ?? "",
      MESSAGEMON_JSON: JSON.stringify(msg),
    }
    if (msg.platformMetadata.platform === "mail") {
      env.MESSAGEMON_MESSAGE_ID = msg.platformMetadata.messageId
      env.MESSAGEMON_ACCOUNT = ""
    }
    await new Promise<void>((resolve, reject) => {
      let child = spawn(params.command, {
        cwd: params.cwd,
        env: { ...process.env, ...env },
        shell: true,
        stdio: "inherit",
      })
      child.on("error", reject)
      child.on("exit", code => {
        if (code === 0) return resolve()
        reject(new Error(`Exec sink command failed with exit code ${code ?? "unknown"}`))
      })
    })
  },
})

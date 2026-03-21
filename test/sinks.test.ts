import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNdjsonSink, createJsonFileSink, createExecSink } from "../src/ingest/sinks"
import type { UnifiedMessage } from "../src/types"

let tmpDir: string

let sampleMessage = (id = "msg-001"): UnifiedMessage => ({
  id,
  platform: "gmail",
  timestamp: "2024-01-15T10:30:00.000Z",
  subject: "Test subject",
  bodyText: "Hello world",
  bodyHtml: "<p>Hello world</p>",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ address: "bob@example.com" }],
  attachments: [{ filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
  threadId: "thread-001",
  platformMetadata: {
    platform: "gmail",
    messageId: id,
    threadId: "thread-001",
    labelIds: ["INBOX"],
    headers: { from: "alice@example.com", subject: "Test subject" },
  },
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msgmon-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("createNdjsonSink", () => {
  it("writes one JSON line per message to a file", async () => {
    let filePath = path.join(tmpDir, "out.jsonl")
    let sink = createNdjsonSink({ filePath })

    await sink.write(sampleMessage("msg-001"))
    await sink.write(sampleMessage("msg-002"))

    let lines = fs.readFileSync(filePath, "utf8").trim().split("\n")
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).id, "msg-001")
    assert.equal(JSON.parse(lines[1]).id, "msg-002")
  })

  it("writes valid JSON on each line", async () => {
    let filePath = path.join(tmpDir, "out.jsonl")
    let sink = createNdjsonSink({ filePath })

    await sink.write(sampleMessage())

    let parsed = JSON.parse(fs.readFileSync(filePath, "utf8").trim())
    assert.equal(parsed.platform, "gmail")
    assert.equal(parsed.subject, "Test subject")
  })
})

describe("createJsonFileSink", () => {
  it("creates one json file per message", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createJsonFileSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    assert.equal(entries.length, 1)
    assert.match(entries[0], /^2024-01-15T10-30-00-000Z_msg-001\.json$/)

    let unified = JSON.parse(fs.readFileSync(path.join(outDir, entries[0]), "utf8"))
    assert.equal(unified.id, "msg-001")
    assert.equal(unified.subject, "Test subject")
  })

  it("stores body fields in the json payload", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createJsonFileSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let unified = JSON.parse(fs.readFileSync(path.join(outDir, entries[0]), "utf8"))
    assert.equal(unified.bodyText, "Hello world")
    assert.equal(unified.bodyHtml, "<p>Hello world</p>")
  })

  it("stores headers in the unified payload", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createJsonFileSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let unified = JSON.parse(fs.readFileSync(path.join(outDir, entries[0]), "utf8"))
    assert.equal(unified.platformMetadata.headers.subject, "Test subject")
  })

  it("creates unique files for different messages", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createJsonFileSink({ outDir })

    await sink.write(sampleMessage("msg-001"))
    await sink.write(sampleMessage("msg-002"))

    let entries = fs.readdirSync(outDir)
    assert.equal(entries.length, 2)
  })

  it("keeps attachments in the json payload even when saveAttachments is true", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createJsonFileSink({
      outDir,
      saveAttachments: true,
      fetchAttachment: async () => Buffer.from("fake-pdf-content"),
    })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let unified = JSON.parse(fs.readFileSync(path.join(outDir, entries[0]), "utf8"))
    assert.equal(unified.attachments.length, 1)
    assert.equal(unified.attachments[0].filename, "report.pdf")
  })
})

describe("createExecSink", () => {
  it("runs a command with MSGMON_* env vars", async () => {
    let outFile = path.join(tmpDir, "exec-out.txt")
    let sink = createExecSink({
      command: `echo "$MSGMON_ID $MSGMON_PLATFORM $MSGMON_SUBJECT" > ${outFile}`,
    })

    await sink.write(sampleMessage())

    let output = fs.readFileSync(outFile, "utf8").trim()
    assert.equal(output, "msg-001 gmail Test subject")
  })

  it("passes MSGMON_JSON containing full message", async () => {
    let outFile = path.join(tmpDir, "exec-json.txt")
    let sink = createExecSink({
      command: `echo "$MSGMON_JSON" > ${outFile}`,
    })

    await sink.write(sampleMessage())

    let parsed = JSON.parse(fs.readFileSync(outFile, "utf8").trim())
    assert.equal(parsed.id, "msg-001")
    assert.equal(parsed.platform, "gmail")
  })

  it("rejects when command fails", async () => {
    let sink = createExecSink({ command: "exit 1" })
    await assert.rejects(() => sink.write(sampleMessage()), /exit code 1/)
  })
})

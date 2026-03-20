import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNdjsonSink, createDirSink, createExecSink } from "../src/ingest/sinks"
import type { UnifiedMessage } from "../src/types"

let tmpDir: string

let sampleMessage = (id = "msg-001"): UnifiedMessage => ({
  id,
  platform: "mail",
  timestamp: "2024-01-15T10:30:00.000Z",
  subject: "Test subject",
  bodyText: "Hello world",
  bodyHtml: "<p>Hello world</p>",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ address: "bob@example.com" }],
  attachments: [{ filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
  threadId: "thread-001",
  platformMetadata: {
    platform: "mail",
    messageId: id,
    threadId: "thread-001",
    labelIds: ["INBOX"],
    headers: { from: "alice@example.com", subject: "Test subject" },
  },
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "messagemon-test-"))
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
    assert.equal(parsed.platform, "mail")
    assert.equal(parsed.subject, "Test subject")
  })
})

describe("createDirSink", () => {
  it("creates a directory per message with unified.json", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createDirSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    assert.equal(entries.length, 1)

    let msgDir = path.join(outDir, entries[0])
    assert.ok(fs.existsSync(path.join(msgDir, "unified.json")))

    let unified = JSON.parse(fs.readFileSync(path.join(msgDir, "unified.json"), "utf8"))
    assert.equal(unified.id, "msg-001")
    assert.equal(unified.subject, "Test subject")
  })

  it("writes body.txt and body.html", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createDirSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let msgDir = path.join(outDir, entries[0])

    assert.equal(fs.readFileSync(path.join(msgDir, "body.txt"), "utf8"), "Hello world")
    assert.equal(fs.readFileSync(path.join(msgDir, "body.html"), "utf8"), "<p>Hello world</p>")
  })

  it("writes headers.json for mail platform", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createDirSink({ outDir })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let msgDir = path.join(outDir, entries[0])

    let headers = JSON.parse(fs.readFileSync(path.join(msgDir, "headers.json"), "utf8"))
    assert.equal(headers.subject, "Test subject")
  })

  it("creates unique directories for different messages", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createDirSink({ outDir })

    await sink.write(sampleMessage("msg-001"))
    await sink.write(sampleMessage("msg-002"))

    let entries = fs.readdirSync(outDir)
    assert.equal(entries.length, 2)
  })

  it("creates attachments dir when saveAttachments is true and fetchAttachment is provided", async () => {
    let outDir = path.join(tmpDir, "inbox")
    let sink = createDirSink({
      outDir,
      saveAttachments: true,
      fetchAttachment: async () => Buffer.from("fake-pdf-content"),
    })

    await sink.write(sampleMessage())

    let entries = fs.readdirSync(outDir)
    let msgDir = path.join(outDir, entries[0])
    let attDir = path.join(msgDir, "attachments")

    assert.ok(fs.existsSync(attDir))
    let attFiles = fs.readdirSync(attDir)
    assert.equal(attFiles.length, 1)
    assert.equal(fs.readFileSync(path.join(attDir, attFiles[0]), "utf8"), "fake-pdf-content")
  })
})

describe("createExecSink", () => {
  it("runs a command with MESSAGEMON_* env vars", async () => {
    let outFile = path.join(tmpDir, "exec-out.txt")
    let sink = createExecSink({
      command: `echo "$MESSAGEMON_ID $MESSAGEMON_PLATFORM $MESSAGEMON_SUBJECT" > ${outFile}`,
    })

    await sink.write(sampleMessage())

    let output = fs.readFileSync(outFile, "utf8").trim()
    assert.equal(output, "msg-001 mail Test subject")
  })

  it("passes MESSAGEMON_JSON containing full message", async () => {
    let outFile = path.join(tmpDir, "exec-json.txt")
    let sink = createExecSink({
      command: `echo "$MESSAGEMON_JSON" > ${outFile}`,
    })

    await sink.write(sampleMessage())

    let parsed = JSON.parse(fs.readFileSync(outFile, "utf8").trim())
    assert.equal(parsed.id, "msg-001")
    assert.equal(parsed.platform, "mail")
  })

  it("rejects when command fails", async () => {
    let sink = createExecSink({ command: "exit 1" })
    await assert.rejects(() => sink.write(sampleMessage()), /exit code 1/)
  })
})

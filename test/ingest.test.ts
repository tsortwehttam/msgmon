import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ingestOnce,
  readIngestState,
  writeIngestState,
  buildDefaultStatePath,
} from "../src/ingest/ingest"
import type { MessageSource, IngestParams } from "../src/ingest/ingest"
import type { Sink } from "../src/ingest/sinks"
import type { UnifiedMessage } from "../src/types"

let tmpDir: string

let makeMsg = (id: string): UnifiedMessage => ({
  id,
  platform: "gmail",
  timestamp: "2024-01-15T10:30:00.000Z",
  subject: `Subject ${id}`,
  bodyText: `Body ${id}`,
  from: { address: "sender@example.com" },
  to: [{ address: "recipient@example.com" }],
  threadId: `thread-${id}`,
  platformMetadata: {
    platform: "gmail",
    messageId: id,
    threadId: `thread-${id}`,
  },
})

let makeMockSource = (messages: UnifiedMessage[]): MessageSource => ({
  async *listMessages() {
    for (let msg of messages) yield msg
  },
})

let makeCollectorSink = (): Sink & { collected: UnifiedMessage[] } => {
  let collected: UnifiedMessage[] = []
  return {
    collected,
    async write(msg) {
      collected.push(msg)
    },
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msgmon-ingest-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("readIngestState / writeIngestState", () => {
  it("returns empty state for nonexistent file", () => {
    let state = readIngestState(path.join(tmpDir, "nonexistent.json"))
    assert.deepEqual(state, { ingested: {} })
  })

  it("roundtrips state through write/read", () => {
    let statePath = path.join(tmpDir, "state.json")
    let state = { ingested: { "msg-001": "2024-01-15T10:30:00.000Z" } }
    writeIngestState(statePath, state)
    let loaded = readIngestState(statePath)
    assert.deepEqual(loaded, state)
  })

  it("returns empty state for corrupt file", () => {
    let statePath = path.join(tmpDir, "corrupt.json")
    fs.writeFileSync(statePath, "not json")
    let state = readIngestState(statePath)
    assert.deepEqual(state, { ingested: {} })
  })
})

describe("buildDefaultStatePath", () => {
  it("returns a deterministic path based on accounts and query", () => {
    let path1 = buildDefaultStatePath({ accounts: ["a", "b"], query: "is:unread" })
    let path2 = buildDefaultStatePath({ accounts: ["b", "a"], query: "is:unread" })
    assert.equal(path1, path2)
  })

  it("returns different paths for different queries", () => {
    let path1 = buildDefaultStatePath({ accounts: ["a"], query: "is:unread" })
    let path2 = buildDefaultStatePath({ accounts: ["a"], query: "is:read" })
    assert.notEqual(path1, path2)
  })
})

describe("ingestOnce", () => {
  it("ingests all messages from a source", async () => {
    let messages = [makeMsg("msg-001"), makeMsg("msg-002"), makeMsg("msg-003")]
    let source = makeMockSource(messages)
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    let result = await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.equal(result.ingested, 3)
    assert.equal(result.scanned, 3)
    assert.equal(sink.collected.length, 3)
    assert.equal(sink.collected[0].id, "msg-001")
  })

  it("skips already-ingested messages", async () => {
    let statePath = path.join(tmpDir, "state.json")
    writeIngestState(statePath, { ingested: { "msg-001": "2024-01-15T00:00:00.000Z" } })

    let messages = [makeMsg("msg-001"), makeMsg("msg-002")]
    let source = makeMockSource(messages)
    let sink = makeCollectorSink()

    let result = await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.equal(result.ingested, 1)
    assert.equal(result.scanned, 2)
    assert.equal(sink.collected.length, 1)
    assert.equal(sink.collected[0].id, "msg-002")
  })

  it("persists state after ingestion", async () => {
    let statePath = path.join(tmpDir, "state.json")
    let source = makeMockSource([makeMsg("msg-001")])
    let sink = makeCollectorSink()

    await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    let state = readIngestState(statePath)
    assert.ok(state.ingested["msg-001"])
  })

  it("handles multiple accounts", async () => {
    let source1 = makeMockSource([makeMsg("acct1-msg")])
    let source2 = makeMockSource([makeMsg("acct2-msg")])
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    let result = await ingestOnce({
      sources: [
        { source: source1, accounts: ["account1"] },
        { source: source2, accounts: ["account2"] },
      ],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.equal(result.ingested, 2)
    assert.equal(sink.collected.length, 2)
  })

  it("calls markRead when doMarkRead is true", async () => {
    let marked: string[] = []
    let source = makeMockSource([makeMsg("msg-001")])
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      markRead: async (msg) => { marked.push(msg.id) },
      doMarkRead: true,
      seed: false,
      verbose: false,
    })

    assert.deepEqual(marked, ["msg-001"])
  })

  it("does not call markRead when doMarkRead is false", async () => {
    let marked: string[] = []
    let source = makeMockSource([makeMsg("msg-001")])
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      markRead: async (msg) => { marked.push(msg.id) },
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.deepEqual(marked, [])
  })

  it("handles empty source gracefully", async () => {
    let source = makeMockSource([])
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    let result = await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.equal(result.ingested, 0)
    assert.equal(result.scanned, 0)
    assert.equal(sink.collected.length, 0)
  })

  it("fan-out across multiple accounts under same source", async () => {
    let callLog: string[] = []
    let source: MessageSource = {
      async *listMessages(params) {
        callLog.push(params.account)
        yield makeMsg(`${params.account}-msg`)
      },
    }
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    await ingestOnce({
      sources: [{ source, accounts: ["work", "personal"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.deepEqual(callLog, ["work", "personal"])
    assert.equal(sink.collected.length, 2)
  })

  it("seed mode records IDs without emitting to sink", async () => {
    let messages = [makeMsg("msg-001"), makeMsg("msg-002")]
    let source = makeMockSource(messages)
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    let result = await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      doMarkRead: false,
      seed: true,
      verbose: false,
    })

    assert.equal(result.ingested, 2)
    assert.equal(result.scanned, 2)
    assert.equal(sink.collected.length, 0)

    let state = readIngestState(statePath)
    assert.ok(state.ingested["msg-001"])
    assert.ok(state.ingested["msg-002"])
  })

  it("seed mode skips markRead even when doMarkRead is true", async () => {
    let marked: string[] = []
    let source = makeMockSource([makeMsg("msg-001")])
    let sink = makeCollectorSink()
    let statePath = path.join(tmpDir, "state.json")

    await ingestOnce({
      sources: [{ source, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink,
      statePath,
      markRead: async (msg) => { marked.push(msg.id) },
      doMarkRead: true,
      seed: true,
      verbose: false,
    })

    assert.deepEqual(marked, [])
    assert.equal(sink.collected.length, 0)
  })

  it("normal ingest after seed skips seeded IDs", async () => {
    let statePath = path.join(tmpDir, "state.json")
    let source1 = makeMockSource([makeMsg("msg-001"), makeMsg("msg-002")])
    let sink1 = makeCollectorSink()

    await ingestOnce({
      sources: [{ source: source1, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink: sink1,
      statePath,
      doMarkRead: false,
      seed: true,
      verbose: false,
    })

    // Now run normally with the same IDs plus a new one
    let source2 = makeMockSource([makeMsg("msg-001"), makeMsg("msg-002"), makeMsg("msg-003")])
    let sink2 = makeCollectorSink()

    let result = await ingestOnce({
      sources: [{ source: source2, accounts: ["test"] }],
      query: "is:unread",
      maxResults: 100,
      sink: sink2,
      statePath,
      doMarkRead: false,
      seed: false,
      verbose: false,
    })

    assert.equal(result.ingested, 1)
    assert.equal(sink2.collected.length, 1)
    assert.equal(sink2.collected[0].id, "msg-003")
  })
})

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { toUnifiedMessage } from "../platforms/mail/toUnifiedMessage"
import type { gmail_v1 } from "googleapis"

let makeMessage = (overrides: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message => ({
  id: "msg-001",
  threadId: "thread-001",
  internalDate: "1700000000000",
  labelIds: ["INBOX", "UNREAD"],
  payload: {
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "bob@example.com, Carol <carol@example.com>" },
      { name: "Cc", value: "dave@example.com" },
      { name: "Subject", value: "Test subject" },
      { name: "Date", value: "Tue, 14 Nov 2023 22:13:20 +0000" },
      { name: "Message-ID", value: "<abc123@example.com>" },
    ],
    mimeType: "text/plain",
    body: {
      data: Buffer.from("Hello world").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
    },
  },
  ...overrides,
})

describe("toUnifiedMessage", () => {
  it("converts a simple Gmail message to UnifiedMessage", () => {
    let msg = makeMessage()
    let unified = toUnifiedMessage(msg)

    assert.equal(unified.id, "msg-001")
    assert.equal(unified.platform, "mail")
    assert.equal(unified.subject, "Test subject")
    assert.equal(unified.bodyText, "Hello world")
    assert.equal(unified.threadId, "thread-001")
  })

  it("parses from with name and address", () => {
    let unified = toUnifiedMessage(makeMessage())
    assert.deepEqual(unified.from, { name: "Alice", address: "alice@example.com" })
  })

  it("parses to with multiple recipients", () => {
    let unified = toUnifiedMessage(makeMessage())
    assert.equal(unified.to?.length, 2)
    assert.equal(unified.to?.[0].address, "bob@example.com")
    assert.deepEqual(unified.to?.[1], { name: "Carol", address: "carol@example.com" })
  })

  it("parses cc recipients", () => {
    let unified = toUnifiedMessage(makeMessage())
    assert.equal(unified.cc?.length, 1)
    assert.equal(unified.cc?.[0].address, "dave@example.com")
  })

  it("converts internalDate to ISO timestamp", () => {
    let unified = toUnifiedMessage(makeMessage())
    assert.equal(unified.timestamp, new Date(1700000000000).toISOString())
  })

  it("populates mail platform metadata", () => {
    let unified = toUnifiedMessage(makeMessage())
    assert.equal(unified.platformMetadata.platform, "mail")
    if (unified.platformMetadata.platform === "mail") {
      assert.equal(unified.platformMetadata.messageId, "msg-001")
      assert.equal(unified.platformMetadata.threadId, "thread-001")
      assert.equal(unified.platformMetadata.rfc822MessageId, "<abc123@example.com>")
      assert.deepEqual(unified.platformMetadata.labelIds, ["INBOX", "UNREAD"])
    }
  })

  it("handles missing fields gracefully", () => {
    let msg: gmail_v1.Schema$Message = {
      id: "msg-002",
      payload: { headers: [] },
    }
    let unified = toUnifiedMessage(msg)

    assert.equal(unified.id, "msg-002")
    assert.equal(unified.subject, undefined)
    assert.equal(unified.from, undefined)
    assert.equal(unified.to, undefined)
    assert.equal(unified.bodyText, undefined)
  })

  it("strips HTML body to text when no plain text part exists", () => {
    let msg = makeMessage({
      payload: {
        headers: [{ name: "Subject", value: "HTML only" }],
        mimeType: "text/html",
        body: {
          data: Buffer.from("<p>Hello <b>world</b></p>")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, ""),
        },
      },
    })
    let unified = toUnifiedMessage(msg)
    assert.ok(unified.bodyText?.includes("Hello"))
    assert.ok(unified.bodyText?.includes("world"))
    assert.ok(!unified.bodyText?.includes("<p>"))
    assert.ok(unified.bodyHtml?.includes("<p>"))
  })

  it("collects attachment metadata", () => {
    let msg = makeMessage({
      payload: {
        headers: [{ name: "Subject", value: "With attachment" }],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Body text").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
            },
          },
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-001", size: 12345 },
          },
        ],
      },
    })
    let unified = toUnifiedMessage(msg)
    assert.equal(unified.attachments?.length, 1)
    assert.equal(unified.attachments?.[0].filename, "report.pdf")
    assert.equal(unified.attachments?.[0].mimeType, "application/pdf")
  })
})

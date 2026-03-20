import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export let AccountParam = z.object({
  account: z.string().default("default"),
})

export let Attachment = z.object({
  filename: z.string().min(1, "filename is required"),
  contentType: z.string().default("application/octet-stream"),
  data: z.string().min(1, "base64 data is required"),
})

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export let GmailSearchRequest = z.object({
  account: z.string().default("default"),
  query: z.string().min(1, "query is required"),
  maxResults: z.number().int().min(1).max(500).default(20),
  fetch: z.enum(["none", "metadata", "full", "summary"]).default("none"),
  previewChars: z.number().int().min(1).default(200),
})
export type GmailSearchRequest = z.infer<typeof GmailSearchRequest>

export let GmailCountRequest = z.object({
  account: z.string().default("default"),
  query: z.string().min(1, "query is required"),
})
export type GmailCountRequest = z.infer<typeof GmailCountRequest>

export let GmailThreadRequest = z.object({
  account: z.string().default("default"),
  threadId: z.string().min(1, "threadId is required"),
})
export type GmailThreadRequest = z.infer<typeof GmailThreadRequest>

export let GmailReadRequest = z.object({
  account: z.string().default("default"),
  messageId: z.string().min(1, "messageId is required"),
})
export type GmailReadRequest = z.infer<typeof GmailReadRequest>

export let GmailSendRequest = z.object({
  account: z.string().default("default"),
  to: z.string().min(1, "to is required"),
  cc: z.array(z.string()).default([]),
  bcc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
  from: z.string().optional(),
  replyTo: z.string().optional(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  messageId: z.string().optional(),
  attachments: z.array(Attachment).default([]),
})
export type GmailSendRequest = z.infer<typeof GmailSendRequest>

export let GmailModifyRequest = z.object({
  account: z.string().default("default"),
  messageId: z.string().min(1, "messageId is required"),
})
export type GmailModifyRequest = z.infer<typeof GmailModifyRequest>

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export let SlackSearchRequest = z.object({
  account: z.string().default("default"),
  query: z.string().min(1, "query is required"),
  maxResults: z.number().int().min(1).max(100).default(20),
})
export type SlackSearchRequest = z.infer<typeof SlackSearchRequest>

export let SlackReadRequest = z.object({
  account: z.string().default("default"),
  channel: z.string().min(1, "channel is required"),
  ts: z.string().min(1, "ts is required"),
})
export type SlackReadRequest = z.infer<typeof SlackReadRequest>

export let SlackSendRequest = z.object({
  account: z.string().default("default"),
  channel: z.string().min(1, "channel is required"),
  text: z.string().default(""),
  threadTs: z.string().optional(),
  asUser: z.boolean().default(true),
  attachments: z.array(Attachment).default([]),
}).refine(d => d.text.length > 0 || d.attachments.length > 0, {
  message: "at least one of text or attachments is required",
})
export type SlackSendRequest = z.input<typeof SlackSendRequest>

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export let IngestRequest = z.object({
  accounts: z.array(z.string()).min(1).default(["default"]),
  query: z.string().default("is:unread"),
  maxResults: z.number().int().min(1).default(100),
  markRead: z.boolean().default(false),
  seed: z.boolean().default(false),
  state: z.string().optional(),
})
export type IngestRequest = z.infer<typeof IngestRequest>

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

export let ApiResponse = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})
export type ApiResponse = z.infer<typeof ApiResponse>

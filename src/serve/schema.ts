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
// Workspace
// ---------------------------------------------------------------------------

export let WorkspaceIdParam = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
})
export type WorkspaceIdParam = z.infer<typeof WorkspaceIdParam>

export let WorkspaceExportRequest = WorkspaceIdParam.extend({
  format: z.enum(["snapshot", "bundle"]).default("snapshot"),
})
export type WorkspaceExportRequest = z.infer<typeof WorkspaceExportRequest>

export let WorkspaceRefreshRequest = WorkspaceIdParam.extend({
  maxResults: z.number().int().min(1).default(100),
  markRead: z.boolean().default(false),
  saveAttachments: z.boolean().default(false),
  seed: z.boolean().default(false),
})
export type WorkspaceRefreshRequest = z.infer<typeof WorkspaceRefreshRequest>

export let WorkspaceBootstrapRequest = WorkspaceIdParam.extend({
  name: z.string().optional(),
  accounts: z.array(z.string()).min(1).default(["default"]),
  query: z.string().default("is:unread"),
  overwrite: z.boolean().default(false),
})
export type WorkspaceBootstrapRequest = z.infer<typeof WorkspaceBootstrapRequest>

export let WorkspaceImportRequest = z.object({
  workspaceId: z.string().min(1).optional(),
  bundleBase64: z.string().min(1, "bundleBase64 is required"),
  overwrite: z.boolean().default(false),
})
export type WorkspaceImportRequest = z.infer<typeof WorkspaceImportRequest>

export let WorkspacePushFile = z.object({
  path: z.string().min(1, "path is required"),
  contentBase64: z.string().optional(),
  deleted: z.boolean().default(false),
}).refine(file => file.deleted || file.contentBase64 != null, {
  message: "contentBase64 is required unless deleted is true",
})
export type WorkspacePushFile = z.infer<typeof WorkspacePushFile>

export let WorkspacePushRequest = WorkspaceIdParam.extend({
  baseRevision: z.string().min(1, "baseRevision is required"),
  files: z.array(WorkspacePushFile).default([]),
})
export type WorkspacePushRequest = z.infer<typeof WorkspacePushRequest>

export let WorkspaceActionDraftSend = z.object({
  type: z.literal("draft.send"),
  draftId: z.string().min(1, "draftId is required"),
  keep: z.boolean().default(false),
})

export let WorkspaceActionDraftDelete = z.object({
  type: z.literal("draft.delete"),
  draftId: z.string().min(1, "draftId is required"),
})

export let WorkspaceActionGmailMarkRead = z.object({
  type: z.literal("message.mark_read.gmail"),
  account: z.string().default("default"),
  messageId: z.string().min(1, "messageId is required"),
})

export let WorkspaceActionSlackMarkRead = z.object({
  type: z.literal("message.mark_read.slack"),
  account: z.string().default("default"),
  channelId: z.string().min(1, "channelId is required"),
  ts: z.string().min(1, "ts is required"),
})

export let WorkspaceActionMessageArchive = z.object({
  type: z.literal("message.archive"),
  account: z.string().default("default"),
  messageId: z.string().min(1, "messageId is required"),
})

export let WorkspaceAction = z.discriminatedUnion("type", [
  WorkspaceActionDraftSend,
  WorkspaceActionDraftDelete,
  WorkspaceActionGmailMarkRead,
  WorkspaceActionSlackMarkRead,
  WorkspaceActionMessageArchive,
])
export type WorkspaceAction = z.infer<typeof WorkspaceAction>

export let WorkspaceActionRequest = WorkspaceIdParam.extend({
  actions: z.array(WorkspaceAction).min(1),
})
export type WorkspaceActionRequest = z.infer<typeof WorkspaceActionRequest>

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export let DraftComposeGmailRequest = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  platform: z.literal("gmail"),
  account: z.string().default("default"),
  label: z.string().optional(),
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

export let DraftComposeSlackRequest = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  platform: z.literal("slack"),
  account: z.string().default("default"),
  label: z.string().optional(),
  channel: z.string().min(1, "channel is required"),
  text: z.string().default(""),
  threadTs: z.string().optional(),
  asUser: z.boolean().default(true),
  attachments: z.array(Attachment).default([]),
})

export let DraftComposeRequest = z.discriminatedUnion("platform", [
  DraftComposeGmailRequest,
  DraftComposeSlackRequest,
])
export type DraftComposeRequest = z.infer<typeof DraftComposeRequest>

export let DraftIdParam = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  id: z.string().min(1, "id is required"),
})

export let DraftListRequest = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  platform: z.enum(["gmail", "slack"]).optional(),
})

export let DraftSendRequest = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  id: z.string().min(1, "id is required"),
  keep: z.boolean().default(false),
})

export let DraftUpdateRequest = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  id: z.string().min(1, "id is required"),
  label: z.string().optional(),
  to: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  from: z.string().optional(),
  channel: z.string().optional(),
  text: z.string().optional(),
  threadId: z.string().optional(),
  threadTs: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  attachments: z.array(Attachment).optional(),
})

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

export let ApiResponse = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})
export type ApiResponse = z.infer<typeof ApiResponse>

import fs from "node:fs"
import path from "node:path"
import yargs from "yargs"
import type { Argv } from "yargs"
import { DEFAULT_ACCOUNT } from "../CliConfig"
import { generateDraftId, saveDraft, loadDraft, listDrafts, deleteDraft } from "./store"
import { sendDraft } from "./send"
import type { Draft } from "./schema"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let readAttachments = (paths: string[]) =>
  paths.map(filePath => ({
    filename: path.basename(filePath),
    contentType: "application/octet-stream",
    data: fs.readFileSync(filePath).toString("base64"),
  }))

let shortId = (id: string) => id.slice(0, 8)

export let configureDraftCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .command(
      "compose",
      "Create a new draft message",
      y =>
        y
          .option("platform", {
            type: "string",
            choices: ["gmail", "slack"] as const,
            demandOption: true,
            describe: "Target platform",
          })
          .option("workspace", {
            type: "string",
            demandOption: true,
            describe: "Workspace id owning this draft",
          })
          .option("account", {
            type: "string",
            default: DEFAULT_ACCOUNT,
            describe: "Account name",
          })
          .option("label", {
            type: "string",
            describe: "Optional label or note for the draft",
          })
          // Gmail fields
          .option("to", { type: "string", describe: "Recipient (gmail)" })
          .option("cc", {
            type: "array",
            string: true,
            default: [] as string[],
            coerce: normalizeMultiValue,
            describe: "CC recipients (gmail)",
          })
          .option("bcc", {
            type: "array",
            string: true,
            default: [] as string[],
            coerce: normalizeMultiValue,
            describe: "BCC recipients (gmail)",
          })
          .option("subject", { type: "string", default: "", describe: "Subject (gmail)" })
          .option("body", { type: "string", default: "", describe: "Message body (gmail) or text (slack)" })
          .option("from", { type: "string", describe: "From address (gmail)" })
          .option("reply-to", { type: "string", describe: "Reply-To header (gmail)" })
          .option("thread-id", { type: "string", describe: "Gmail threadId for threading" })
          .option("in-reply-to", { type: "string", describe: "In-Reply-To header (gmail)" })
          .option("references", { type: "string", describe: "References header (gmail)" })
          .option("message-id", { type: "string", describe: "Message-ID override (gmail)" })
          // Slack fields
          .option("channel", { type: "string", describe: "Channel ID or #name (slack)" })
          .option("text", { type: "string", describe: "Message text (slack)" })
          .option("thread-ts", { type: "string", describe: "Thread timestamp (slack)" })
          .option("as-user", { type: "boolean", default: true, describe: "Send as user (slack)" })
          // Shared
          .option("attach", {
            type: "array",
            string: true,
            default: [] as string[],
            coerce: normalizeMultiValue,
            describe: "Attachment file path(s)",
          }),
      async argv => {
        let now = new Date().toISOString()
        let id = generateDraftId()
        let attachments = readAttachments(argv.attach)
        let draft: Draft

        if (argv.platform === "gmail") {
          if (!argv.to) throw new Error("--to is required for gmail drafts")
          draft = {
            id,
            createdAt: now,
            updatedAt: now,
            platform: "gmail",
            account: argv.account,
            label: argv.label,
            to: argv.to,
            cc: argv.cc,
            bcc: argv.bcc,
            subject: argv.subject,
            body: argv.body,
            from: argv.from,
            replyTo: argv.replyTo,
            threadId: argv.threadId,
            inReplyTo: argv.inReplyTo,
            references: argv.references,
            messageId: argv.messageId,
            attachments,
          }
        } else {
          if (!argv.channel) throw new Error("--channel is required for slack drafts")
          let text = argv.text ?? argv.body
          if (!text && attachments.length === 0) throw new Error("--text or --attach is required for slack drafts")
          draft = {
            id,
            createdAt: now,
            updatedAt: now,
            platform: "slack",
            account: argv.account,
            label: argv.label,
            channel: argv.channel,
            text: text ?? "",
            threadTs: argv.threadTs,
            asUser: argv.asUser,
            attachments,
          }
        }

        let filePath = saveDraft(argv.workspace, draft)
        console.log(JSON.stringify({ workspaceId: argv.workspace, id: draft.id, platform: draft.platform, path: filePath }))
      },
    )
    .command(
      "list",
      "List all pending drafts",
      y =>
        y
          .option("format", {
            type: "string",
            choices: ["json", "text"] as const,
            default: "json",
            describe: "Output format",
          })
          .option("workspace", {
            type: "string",
            demandOption: true,
            describe: "Workspace id",
          })
          .option("platform", {
            type: "string",
            choices: ["gmail", "slack"] as const,
            describe: "Filter by platform",
          }),
      async argv => {
        let drafts = listDrafts(argv.workspace, argv.platform)
        if (argv.format === "text") {
          if (drafts.length === 0) {
            console.log("No drafts.")
            return
          }
          for (let d of drafts) {
            let target = d.platform === "gmail" ? d.to : d.channel
            let preview = d.platform === "gmail" ? d.subject : d.text
            if (preview && preview.length > 60) preview = preview.slice(0, 57) + "..."
            let label = d.label ? ` [${d.label}]` : ""
            console.log(`${shortId(d.id)}  ${d.platform}  ${d.account}  ${target}  ${preview || "(empty)"}${label}`)
          }
        } else {
          console.log(JSON.stringify(drafts, null, 2))
        }
      },
    )
    .command(
      "show <id>",
      "Show a draft by ID (prefix match)",
      y => y
        .positional("id", { type: "string", demandOption: true, describe: "Draft ID or prefix" })
        .option("workspace", { type: "string", demandOption: true, describe: "Workspace id" }),
      async argv => {
        let draft = resolveDraft(argv.workspace, argv.id!)
        console.log(JSON.stringify(draft, null, 2))
      },
    )
    .command(
      "edit <id>",
      "Update fields on an existing draft",
      y =>
        y
          .positional("id", { type: "string", demandOption: true, describe: "Draft ID or prefix" })
          .option("workspace", { type: "string", demandOption: true, describe: "Workspace id" })
          .option("label", { type: "string", describe: "Label or note" })
          .option("to", { type: "string", describe: "Recipient (gmail)" })
          .option("cc", { type: "array", string: true, coerce: normalizeMultiValue, describe: "CC (gmail)" })
          .option("bcc", { type: "array", string: true, coerce: normalizeMultiValue, describe: "BCC (gmail)" })
          .option("subject", { type: "string", describe: "Subject (gmail)" })
          .option("body", { type: "string", describe: "Body (gmail) or text (slack)" })
          .option("from", { type: "string", describe: "From (gmail)" })
          .option("channel", { type: "string", describe: "Channel (slack)" })
          .option("text", { type: "string", describe: "Text (slack)" })
          .option("thread-id", { type: "string", describe: "Gmail threadId" })
          .option("thread-ts", { type: "string", describe: "Slack thread timestamp" })
          .option("in-reply-to", { type: "string", describe: "In-Reply-To (gmail)" })
          .option("references", { type: "string", describe: "References (gmail)" })
          .option("attach", {
            type: "array",
            string: true,
            coerce: normalizeMultiValue,
            describe: "Replace attachments with these file paths",
          }),
      async argv => {
        let draft = resolveDraft(argv.workspace, argv.id!)

        if (argv.label !== undefined) draft.label = argv.label
        if (argv.attach) draft.attachments = readAttachments(argv.attach)

        if (draft.platform === "gmail") {
          if (argv.to !== undefined) draft.to = argv.to
          if (argv.cc) draft.cc = argv.cc
          if (argv.bcc) draft.bcc = argv.bcc
          if (argv.subject !== undefined) draft.subject = argv.subject
          if (argv.body !== undefined) draft.body = argv.body
          if (argv.from !== undefined) draft.from = argv.from
          if (argv.threadId !== undefined) draft.threadId = argv.threadId
          if (argv.inReplyTo !== undefined) draft.inReplyTo = argv.inReplyTo
          if (argv.references !== undefined) draft.references = argv.references
        } else if (draft.platform === "slack") {
          if (argv.channel !== undefined) draft.channel = argv.channel
          if (argv.text !== undefined) draft.text = argv.text
          else if (argv.body !== undefined) draft.text = argv.body
          if (argv.threadTs !== undefined) draft.threadTs = argv.threadTs
        }

        draft.updatedAt = new Date().toISOString()
        saveDraft(argv.workspace, draft)
        console.log(JSON.stringify(draft, null, 2))
      },
    )
    .command(
      "send <id>",
      "Send a draft as a real message",
      y =>
        y
          .positional("id", { type: "string", demandOption: true, describe: "Draft ID or prefix" })
          .option("workspace", { type: "string", demandOption: true, describe: "Workspace id" })
          .option("yes", {
            type: "boolean",
            default: false,
            describe: "Required safety flag to actually send",
          })
          .option("keep", {
            type: "boolean",
            default: false,
            describe: "Keep the draft after sending (default: delete on success)",
          }),
      async argv => {
        if (!argv.yes) throw new Error("Refusing to send without --yes")
        let draft = resolveDraft(argv.workspace, argv.id!)
        let result = await sendDraft(draft)
        if (!argv.keep) deleteDraft(argv.workspace, draft.id)
        console.log(JSON.stringify({ workspaceId: argv.workspace, sent: true, draftId: draft.id, deleted: !argv.keep, result }))
      },
    )
    .command(
      "delete <id>",
      "Delete a draft",
      y => y
        .positional("id", { type: "string", demandOption: true, describe: "Draft ID or prefix" })
        .option("workspace", { type: "string", demandOption: true, describe: "Workspace id" }),
      async argv => {
        let draft = resolveDraft(argv.workspace, argv.id!)
        deleteDraft(argv.workspace, draft.id)
        console.log(JSON.stringify({ workspaceId: argv.workspace, deleted: true, id: draft.id }))
      },
    )
    .demandCommand(1, "Choose a command: compose, list, show, edit, send, or delete.")
    .strict()
    .help()

/** Resolve a draft by full ID or prefix match */
let resolveDraft = (workspaceId: string, idOrPrefix: string): Draft => {
  // Try exact match first
  try {
    return loadDraft(workspaceId, idOrPrefix)
  } catch { /* continue to prefix match */ }

  // Prefix match
  let all = listDrafts(workspaceId)
  let matches = all.filter(d => d.id.startsWith(idOrPrefix))
  if (matches.length === 0) throw new Error(`No draft matching "${idOrPrefix}"`)
  if (matches.length > 1) throw new Error(`Ambiguous prefix "${idOrPrefix}" matches ${matches.length} drafts`)
  return matches[0]
}

export let parseDraftCli = (args: string[], scriptName = "msgmon draft") =>
  configureDraftCli(yargs(args).scriptName(scriptName)).parseAsync()

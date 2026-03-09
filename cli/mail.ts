import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { DEFAULT_ACCOUNT, resolveCredentialsPath, resolveTokenReadPathForAccount } from "../src/CliConfig"
import type { Argv } from "yargs"
import { verboseLog } from "../src/Verbose"

let loadOAuth = (account: string, verbose = false) => {
  let credentialsPath = resolveCredentialsPath()
  let tokenPath = resolveTokenReadPathForAccount(account)
  verboseLog(verbose, "mail auth", { account, credentialsPath, tokenPath })

  let raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
  let c = raw.installed ?? raw.web
  if (!c?.client_id || !c?.client_secret) throw new Error("Bad credentials.json (missing client_id/client_secret)")
  let o = new google.auth.OAuth2(c.client_id, c.client_secret, (c.redirect_uris ?? [])[0])
  let t = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
  o.setCredentials(t)
  return o
}

let gmail = (account: string, verbose = false) => google.gmail({ version: "v1", auth: loadOAuth(account, verbose) })

let base64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

let chunk76 = (s: string) => (s.match(/.{1,76}/g) ?? []).join("\r\n")

let encodeQuotedPrintable = (input: string) => {
  let lines = input.split(/\r?\n/)
  let encoded: string[] = []
  for (let line of lines) {
    let current = ""
    for (let i = 0; i < line.length; i++) {
      let char = line[i]
      let code = line.charCodeAt(i)
      let bytes = Buffer.from(char, "utf8")
      let chunk: string
      if (bytes.length === 1 && code >= 33 && code <= 126 && code !== 61) {
        chunk = char
      } else if ((code === 9 || code === 32) && i < line.length - 1) {
        chunk = char
      } else {
        chunk = Array.from(bytes)
          .map(x => `=${x.toString(16).toUpperCase().padStart(2, "0")}`)
          .join("")
      }
      if (current.length + chunk.length > 75) {
        encoded.push(current + "=")
        current = chunk
      } else {
        current += chunk
      }
    }
    encoded.push(current)
  }
  return encoded.join("\r\n")
}

let normalizeMessageId = (value?: string) => {
  let trimmed = (value ?? "").trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed
  if (!trimmed.includes("@")) return undefined
  return `<${trimmed}>`
}

let dedupeReferences = (value?: string) => {
  let refs = (value ?? "")
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x.startsWith("<") && x.endsWith(">") ? x : normalizeMessageId(x) ?? `<${x}>`))
  return Array.from(new Set(refs)).join(" ")
}

let buildMessageId = (from?: string) => {
  let domain = from?.split("@")[1] ?? "localhost"
  return `<${crypto.randomBytes(12).toString("hex")}.${Date.now()}@${domain}>`
}

let guessMimeType = (filePath: string) => {
  let ext = path.extname(filePath).toLowerCase()
  if (ext === ".txt") return "text/plain"
  if (ext === ".html" || ext === ".htm") return "text/html"
  if (ext === ".json") return "application/json"
  if (ext === ".pdf") return "application/pdf"
  if (ext === ".csv") return "text/csv"
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  return "application/octet-stream"
}

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let buildRawMessage = (params: {
  from?: string
  to: string
  cc: string[]
  bcc: string[]
  replyTo?: string
  inReplyTo?: string
  references?: string
  messageId?: string
  subject: string
  body: string
  attach: string[]
}) => {
  let normalizedInReplyTo = normalizeMessageId(params.inReplyTo)
  let normalizedReferences = dedupeReferences(
    [params.references, normalizedInReplyTo].filter(Boolean).join(" ").trim() || undefined,
  )
  let headers = [
    ...(params.from ? [`From: ${params.from}`] : []),
    `To: ${params.to}`,
    ...(params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc.length > 0 ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    ...(params.replyTo ? [`Reply-To: ${params.replyTo}`] : []),
    ...(normalizedInReplyTo ? [`In-Reply-To: ${normalizedInReplyTo}`] : []),
    ...(normalizedReferences ? [`References: ${normalizedReferences}`] : []),
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${normalizeMessageId(params.messageId) ?? buildMessageId(params.from)}`,
    "MIME-Version: 1.0",
    "X-Mailer: mailmon/1.0",
  ]

  if (params.attach.length === 0) {
    return (
      headers.join("\r\n") +
      `\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(params.body)}`
    )
  }

  let boundary = `mailmon_${Date.now()}_${Math.random().toString(36).slice(2)}`
  let parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(params.body)}\r\n`,
    ...params.attach.map(filePath => {
      let filename = path.basename(filePath).replace(/"/g, "")
      let content = fs.readFileSync(filePath).toString("base64")
      return (
        `--${boundary}\r\n` +
        `Content-Type: ${guessMimeType(filePath)}; name="${filename}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n" +
        `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
        `${chunk76(content)}\r\n`
      )
    }),
    `--${boundary}--`,
  ]

  return headers.join("\r\n") + `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` + parts.join("")
}

export let configureMailCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 <command> [options]")
    .option("account", {
      type: "string",
      default: DEFAULT_ACCOUNT,
      describe: "Token account name (uses .mailmon/tokens/<account>.json)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .command(
    "search <query>",
    "Search messages by Gmail query; returns refs or hydrated message payloads",
    y =>
      y
        .positional("query", {
          type: "string",
          describe: 'Gmail query, e.g. "from:someone newer_than:7d"',
        })
        .option("max-results", {
          type: "number",
          default: 20,
          coerce: value => {
            if (!Number.isFinite(value) || value < 1 || value > 500) throw new Error("--max-results must be 1..500")
            return Math.floor(value)
          },
          describe: "Maximum matched messages to return",
        })
        .option("fetch", {
          type: "string",
          default: "none",
          choices: ["none", "metadata", "full"] as const,
          describe: "Optionally fetch matched message payloads: none, metadata, or full",
        }),
    async argv => {
      let client = gmail(argv.account, argv.verbose)
      let r = await client.users.messages.list({ userId: "me", q: argv.query, maxResults: argv.maxResults })
      let msgs = r.data.messages ?? []
      let resolvedMessages: unknown[] | undefined
      if (argv.fetch !== "none") {
        resolvedMessages = []
        for (let message of msgs) {
          if (!message.id) continue
          let fetched = await client.users.messages.get({
            userId: "me",
            id: message.id,
            format: argv.fetch,
            ...(argv.fetch === "metadata"
              ? { metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"] }
              : {}),
          })
          resolvedMessages.push(fetched.data)
        }
      }
      verboseLog(argv.verbose, "search results", { count: msgs.length, fetch: argv.fetch })
      if (resolvedMessages) {
        console.log(
          JSON.stringify(
            {
              query: argv.query,
              messages: msgs,
              resolvedMessages,
            },
            null,
            2,
          ),
        )
        return
      }
      console.log(JSON.stringify(msgs, null, 2))
    },
    )
    .command(
    "read <messageId>",
    "Read message metadata; returns JSON object with payload headers and ids",
    y =>
      y.positional("messageId", {
        type: "string",
        describe: "Gmail message id",
      }),
    async argv => {
      let r = await gmail(argv.account, argv.verbose).users.messages.get({
        userId: "me",
        id: argv.messageId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      })
      verboseLog(argv.verbose, "read message", { id: argv.messageId, threadId: r.data.threadId })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "send",
    "Send a message with optional cc/bcc/attachments/threading headers; returns Gmail send response JSON",
    y =>
      y
        .option("to", {
          type: "string",
          demandOption: true,
          describe: "Recipient email address",
        })
        .option("cc", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "CC recipient(s), repeat flag or pass comma-separated values",
        })
        .option("bcc", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "BCC recipient(s), repeat flag or pass comma-separated values",
        })
        .option("reply-to", {
          type: "string",
          describe: "Reply-To header value",
        })
        .option("from", {
          type: "string",
          describe: "Optional From header (must be authorized in Gmail sender settings)",
        })
        .option("thread-id", {
          type: "string",
          describe: "Gmail threadId for threading",
        })
        .option("in-reply-to", {
          type: "string",
          describe: "In-Reply-To header (RFC 822 Message-ID)",
        })
        .option("references", {
          type: "string",
          describe: "References header value",
        })
        .option("message-id", {
          type: "string",
          describe: "Optional Message-ID header override",
        })
        .option("subject", {
          type: "string",
          default: "",
          describe: "Message subject",
        })
        .option("body", {
          type: "string",
          default: "",
          describe: "Message body",
        })
        .option("attach", {
          type: "array",
          string: true,
          default: [],
          coerce: normalizeMultiValue,
          describe: "Attachment file path(s), repeat flag to include multiple",
        })
        .option("yes", {
          type: "boolean",
          default: false,
          describe: "Required safety flag to actually send",
        }),
    async argv => {
      if (!argv.yes) throw new Error("Refusing to send without --yes")
      verboseLog(argv.verbose, "send request", {
        account: argv.account,
        to: argv.to,
        ccCount: argv.cc.length,
        bccCount: argv.bcc.length,
        attachments: argv.attach,
        threadId: argv.threadId,
      })

      let raw = buildRawMessage({
        from: argv.from,
        to: argv.to,
        cc: argv.cc,
        bcc: argv.bcc,
        replyTo: argv.replyTo,
        inReplyTo: argv.inReplyTo,
        references: argv.references,
        messageId: argv.messageId,
        subject: argv.subject,
        body: argv.body,
        attach: argv.attach,
      })

      let r = await gmail(argv.account, argv.verbose).users.messages.send({
        userId: "me",
        requestBody: {
          raw: base64url(raw),
          ...(argv.threadId ? { threadId: argv.threadId } : {}),
        },
      })
      verboseLog(argv.verbose, "send response", { id: r.data.id, threadId: r.data.threadId })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "mark-read <messageId>",
    "Mark a message as read by removing the Gmail UNREAD label",
    y =>
      y.positional("messageId", {
        type: "string",
        describe: "Gmail message id",
      }),
    async argv => {
      let r = await gmail(argv.account, argv.verbose).users.messages.modify({
        userId: "me",
        id: argv.messageId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      })
      verboseLog(argv.verbose, "mark-read message", { id: argv.messageId, labelIds: r.data.labelIds })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .command(
    "archive <messageId>",
    "Archive a message by removing the Gmail INBOX label",
    y =>
      y.positional("messageId", {
        type: "string",
        describe: "Gmail message id",
      }),
    async argv => {
      let r = await gmail(argv.account, argv.verbose).users.messages.modify({
        userId: "me",
        id: argv.messageId,
        requestBody: {
          removeLabelIds: ["INBOX"],
        },
      })
      verboseLog(argv.verbose, "archive message", { id: argv.messageId, labelIds: r.data.labelIds })
      console.log(JSON.stringify(r.data, null, 2))
    },
    )
    .example("$0 search \"from:alerts@example.com newer_than:7d\"", "Find recent messages")
    .example("$0 search \"in:inbox is:unread\" --fetch=metadata", "Find matches and include hydrated metadata payloads")
    .example("$0 read 190cf9f55b05efcc", "Read metadata for one Gmail message id")
    .example("$0 mark-read 190cf9f55b05efcc", "Mark one Gmail message as read")
    .example("$0 archive 190cf9f55b05efcc", "Archive one Gmail message (remove INBOX label)")
    .example("$0 send --to user@example.com --subject \"Hi\" --body \"Hello\" --yes", "Send plain-text email")
    .example(
      "$0 send --to user@example.com --cc a@example.com,b@example.com --bcc archive@example.com --subject \"Report\" --attach ./report.pdf --attach ./metrics.csv --yes",
      "Send with multiple recipients and attachments",
    )
    .example(
      "$0 send --to user@example.com --thread-id 190cb53f30f3d1aa --in-reply-to \"<orig@id>\" --references \"<orig@id>\" --body \"Following up\" --yes",
      "Reply in a Gmail thread using thread and message-id headers",
    )
    .epilog(
      [
        "Read state notes:",
        "- `mark-read` removes the `UNREAD` label from the specified message id.",
        "- `archive` removes the `INBOX` label from the specified message id.",
        "- Requires OAuth scope `https://www.googleapis.com/auth/gmail.modify`.",
        "- If your existing token predates this scope, rerun `mailmon auth --account=<name>`.",
        "",
        "Send behavior notes:",
        "- `--yes` is required to send (safety flag).",
        "- `--cc`, `--bcc`, and `--attach` accept repeated flags and comma-separated values.",
        "- `--thread-id` sets Gmail API thread routing.",
        "- `--in-reply-to` and `--references` set RFC 5322 threading headers.",
        "- If `--in-reply-to` is provided, it is normalized and merged into `References`.",
        "- `--verbose` prints resolved credential/token paths and operation diagnostics to stderr.",
      ].join("\n"),
    )
    .demandCommand(1, "Choose a command: search, read, mark-read, archive, or send.")
    .strict()
    .recommendCommands()
    .help()

export let parseMailCli = (args: string[], scriptName = "mail") => configureMailCli(yargs(args).scriptName(scriptName)).parseAsync()

export let runMailCli = (args = hideBin(process.argv), scriptName = "mail") =>
  parseMailCli(args, scriptName).catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runMailCli()
}

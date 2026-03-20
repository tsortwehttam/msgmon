import yargs from "yargs"
import type { Argv } from "yargs"
import { startServer, type Capability, type TokenSpec } from "./server"

let normalizeMultiValue = (value: unknown) => {
  if (value == null) return []
  let raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(x => String(x).split(","))
    .map(x => x.trim())
    .filter(Boolean)
}

let ALL_CAPABILITIES: Capability[] = ["all"]

let parseScopedToken = (value: string): TokenSpec => {
  let [token, caps] = value.split("=", 2)
  if (!token || !caps) throw new Error(`Invalid --scoped-token "${value}". Expected <token>=<cap1>,<cap2>`)
  let capabilities = caps.split(",").map(x => x.trim()).filter(Boolean) as Capability[]
  if (capabilities.length === 0) throw new Error(`Invalid --scoped-token "${value}". No capabilities provided`)
  return { token, capabilities }
}

export let configureServeCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .option("port", {
      type: "number",
      default: 3271,
      describe: "Port to listen on",
    })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      describe: "Host/address to bind to",
    })
    .option("token", {
      type: "array",
      string: true,
      default: [],
      coerce: normalizeMultiValue,
      describe: "Full-access token(s) for X-Auth-Token auth",
    })
    .option("scoped-token", {
      type: "array",
      string: true,
      default: [],
      coerce: normalizeMultiValue,
      describe: "Scoped token(s) in the form <token>=<cap1>,<cap2>",
    })
    .option("gmail-allow-to", {
      type: "array",
      string: true,
      default: [],
      coerce: normalizeMultiValue,
      describe: "Allowed Gmail recipients; sends to others are silently stripped",
    })
    .option("slack-allow-channels", {
      type: "array",
      string: true,
      default: [],
      coerce: normalizeMultiValue,
      describe: "Allowed Slack channels; sends to others are rejected",
    })
    .option("send-rate-limit", {
      type: "number",
      default: 0,
      coerce: (value: number) => {
        if (value != null && (!Number.isFinite(value) || value < 0))
          throw new Error("--send-rate-limit must be a non-negative number")
        return Math.floor(value)
      },
      describe: "Max sends per minute across all platforms (0 = unlimited)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .example("$0 --token=mysecret", "Start server on default port with a full-access token")
    .example("$0 --token=mysecret --gmail-allow-to=a@x.com,b@x.com", "Only allow sends to a@x.com and b@x.com")
    .example("$0 --token=mysecret --slack-allow-channels=general,alerts", "Only allow Slack posts to #general and #alerts")
    .example("$0 --scoped-token=reader=read,workspace_read --scoped-token=writer=workspace_write,drafts", "Start server with restricted tokens")
    .example("$0 --token=mysecret --send-rate-limit=10", "Cap all sends at 10 per minute")
    .epilog(
      [
        "Authentication:",
        "  Every request must include the header: X-Auth-Token: <token>",
        "  Requests without a valid token receive 401 Unauthorized.",
        "  --token grants full access. --scoped-token grants only named capabilities.",
        "  Capabilities: read, ingest, drafts, send, workspace_read, workspace_write, workspace_actions.",
        "",
        "Send filtering:",
        "  --gmail-allow-to restricts outbound email recipients. Disallowed addresses",
        "  are silently stripped from to/cc/bcc. If no allowed recipients remain, the",
        "  request returns 400. Omit to allow all recipients.",
        "",
        "  --slack-allow-channels restricts which Slack channels can be posted to.",
        "  Sends to disallowed channels return 400. Omit to allow all channels.",
        "",
        "Rate limiting:",
        "  --send-rate-limit sets a global per-minute cap on sends (Gmail + Slack",
        "  combined). Excess requests return 429 with a Retry-After hint. Set to 0",
        "  (default) to disable rate limiting.",
        "",
        "Endpoints (all POST, JSON body):",
        "  /api/gmail/search      — Search Gmail messages",
        "  /api/gmail/count       — Count Gmail results",
        "  /api/gmail/thread      — Get all messages in a thread",
        "  /api/gmail/read        — Read a single message",
        "  /api/gmail/send        — Send an email (subject to filtering/rate limit)",
        "  /api/gmail/mark-read   — Mark a message as read",
        "  /api/gmail/archive     — Archive a message",
        "  /api/gmail/accounts    — List configured Gmail accounts",
        "  /api/slack/search     — Search Slack messages",
        "  /api/slack/read       — Read a Slack message",
        "  /api/slack/send       — Post a Slack message (subject to filtering/rate limit)",
        "  /api/slack/accounts   — List configured Slack workspaces",
        "  /api/ingest           — One-shot ingest across accounts",
        "",
        "  /api/draft/compose    — Create a workspace-owned draft",
        "  /api/draft/list       — List workspace drafts",
        "  /api/draft/show       — Show a workspace draft by ID",
        "  /api/draft/update     — Update workspace draft fields",
        "  /api/draft/send       — Send a workspace draft (subject to filtering/rate limit)",
        "  /api/draft/delete     — Delete a workspace draft",
        "",
        "  /api/workspace/export  — Export an agent-safe workspace snapshot or bundle",
        "  /api/workspace/bootstrap — Create a workspace",
        "  /api/workspace/import  — Import a bundled workspace",
        "  /api/workspace/refresh — Ingest new messages into a workspace inbox",
        "  /api/workspace/push    — Push bounded file changes back to the workspace",
        "  /api/workspace/actions — Apply privileged workspace actions via policy checks",
        "",
        "  GET /api/health       — Health check (still requires auth)",
        "",
        "Request bodies are validated with Zod. Errors return { ok: false, error: '...' }.",
      ].join("\n"),
    )
    .strict()
    .help()

export let parseServeCli = async (args: string[], scriptName = "msgmon serve") => {
  let argv = await configureServeCli(yargs(args).scriptName(scriptName)).parseAsync()
  let tokens: TokenSpec[] = [
    ...(argv.token as string[]).map(token => ({ token, capabilities: ALL_CAPABILITIES })),
    ...(argv.scopedToken as string[]).map(parseScopedToken),
  ]
  if (tokens.length === 0) throw new Error("At least one --token or --scoped-token is required")
  await startServer({
    port: argv.port,
    host: argv.host,
    tokens,
    verbose: argv.verbose,
    gmailAllowTo: argv.gmailAllowTo,
    slackAllowChannels: argv.slackAllowChannels,
    sendRateLimit: argv.sendRateLimit,
  })
}

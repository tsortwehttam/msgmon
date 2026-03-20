# msgmon

Multi-account message ingestion CLI. Supports Gmail and Slack; Teams and WhatsApp adapters are planned.

## Install

```bash
npm install
npm link
msgmon --help
```

To remove the global link:

```bash
npm unlink -g msgmon
```

## Gmail Setup (OAuth)

1. In Google Cloud, create/select a project, enable `Gmail API`, configure the OAuth consent screen, and create an OAuth Client ID (Desktop app).
2. Save the client JSON as `.msgmon/gmail/credentials.json` (or `~/.msgmon/gmail/credentials.json`).
3. Authorize an account:

```bash
msgmon gmail auth --account=personal
```

4. Verify:

```bash
msgmon gmail accounts --format=text
msgmon gmail search "in:inbox is:unread" --account=personal
```

The tool requests scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`.

## Slack Setup

### Option A: Bot token (simplest)

1. Create a Slack app at https://api.slack.com/apps.
2. Under **OAuth & Permissions**, add bot scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `mpim:history`, `users:read`, `chat:write`.
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).
4. Store it:

```bash
msgmon slack auth --token=xoxb-... --account=myworkspace
```

### Option B: OAuth (enables send-as-user and search)

1. Save your app's `client_id` and `client_secret` to `.msgmon/slack/credentials.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```
2. Run the OAuth flow:
   ```bash
   msgmon slack auth --mode=oauth --account=myworkspace
   ```
3. This stores both a bot token and a user token. The user token enables `search` and sending messages as yourself.

### Verify

```bash
msgmon slack accounts --format=text
msgmon slack read '#general' 1234567890.123456 --account=myworkspace
```

## Commands

### `msgmon ingest`

One-shot: scan accounts, emit new messages to a sink, then exit. Safe to run from cron.

```bash
msgmon ingest --account=work --account=personal --sink=dir --out-dir=./inbox --save-attachments
msgmon ingest --sink=ndjson > today.jsonl
msgmon ingest --sink=exec --exec-cmd='./handle.sh' --mark-read
msgmon ingest --query='from:billing@example.com' --state=./state.json
msgmon ingest --seed --query='newer_than:30d' --max-results=500
```

### `msgmon watch`

Daemon: continuously poll and emit new messages as they arrive.

```bash
msgmon watch --account=work --sink=ndjson | my-router
msgmon watch --sink=dir --out-dir=/data/inbox --save-attachments --interval-ms=10000
msgmon watch --sink=exec --exec-cmd='./agent.sh' --mark-read
```

### `msgmon corpus`

Build an LLM-oriented corpus from ingested message directories. Platform-agnostic.

```bash
msgmon corpus --from=./inbox --out-dir=./corpus
msgmon corpus --from=./inbox --out-dir=./corpus --chunk-chars=8000
```

Outputs `messages.jsonl`, `chunks.jsonl`, `threads.jsonl`, and `summary.json`.

### `msgmon serve`

HTTP API server that exposes all commands as JSON endpoints with token authentication. Designed to run in an isolated environment so that an LLM agent can interact with messaging platforms via a simple bearer token without ever having direct access to OAuth credentials, API keys, or account tokens. The secrets stay on the server; the LLM only sees the HTTP interface.

```bash
msgmon serve --token=mysecret
msgmon serve --token=mysecret --port=8080 --host=0.0.0.0
msgmon serve --token=mysecret --gmail-allow-to=a@x.com,b@x.com --send-rate-limit=10
msgmon serve --token=mysecret --slack-allow-channels=general,alerts
```

Every request must include the header `X-Auth-Token: <token>`. All endpoints accept `POST` with a JSON body and return `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`. Request bodies are validated with Zod.

**Send filtering:**
- `--gmail-allow-to` — comma-separated list of allowed email recipients. Disallowed addresses are silently stripped from to/cc/bcc. If no allowed recipients remain, the request returns 400. Omit to allow all.
- `--slack-allow-channels` — comma-separated list of allowed Slack channels. Sends to disallowed channels return 400. Omit to allow all.
- `--send-rate-limit` — max sends per minute across Gmail + Slack combined. Excess requests return 429 with retry hint. Default 0 (unlimited).

| Endpoint | Description |
|----------|-------------|
| `POST /api/gmail/search` | Search Gmail (`{ query, account?, maxResults?, fetch? }`) |
| `POST /api/gmail/count` | Count Gmail results (`{ query, account? }`) |
| `POST /api/gmail/thread` | Get thread messages (`{ threadId, account? }`) |
| `POST /api/gmail/read` | Read a message (`{ messageId, account? }`) |
| `POST /api/gmail/send` | Send email (`{ to, subject, body, account?, cc?, bcc?, threadId?, attachments? }`) |
| `POST /api/gmail/mark-read` | Mark as read (`{ messageId, account? }`) |
| `POST /api/gmail/archive` | Archive (`{ messageId, account? }`) |
| `POST /api/gmail/accounts` | List mail accounts (`{}`) |
| `POST /api/slack/search` | Search Slack (`{ query, account?, maxResults? }`) |
| `POST /api/slack/read` | Read a message (`{ channel, ts, account? }`) |
| `POST /api/slack/send` | Post a message (`{ channel, text?, account?, threadTs?, asUser?, attachments? }`) |
| `POST /api/slack/accounts` | List Slack workspaces (`{}`) |
| `POST /api/ingest` | One-shot ingest (`{ accounts?, query?, maxResults?, markRead?, seed? }`) |
| `GET /api/health` | Health check (returns `{ status: "ok", uptime }`) |

**Attachments** (for `/api/gmail/send` and `/api/slack/send`): pass an `attachments` array in the JSON body. Each attachment is `{ filename, data, contentType? }` where `data` is base64-encoded file content. Slack file uploads require the `files:write` bot/user scope.

### Sinks

Both `ingest` and `watch` support three output sinks:

| Sink | Flag | Description |
|------|------|-------------|
| **ndjson** | `--sink=ndjson` (default) | One `UnifiedMessage` JSON per line to stdout. Pipe-friendly. |
| **dir** | `--sink=dir --out-dir=PATH` | One directory per message: `unified.json`, `body.txt`, `body.html`, `headers.json`, `attachments/`. |
| **exec** | `--sink=exec --exec-cmd=CMD` | Run a shell command per message with `MSGMON_*` env vars and `MSGMON_JSON`. |

### Shared ingest/watch flags

| Flag | Default | Description |
|------|---------|-------------|
| `--account` | `default` | Account name(s), repeatable/comma-separated |
| `--query` | `is:unread` | Platform-native search query |
| `--max-results` | `100` | Max messages per account per cycle |
| `--mark-read` | `false` | Mark messages as read after ingestion |
| `--seed` | `false` | Record IDs in state without emitting to sink (cold-start seeding) |
| `--save-attachments` | `false` | Download attachments (dir sink only) |
| `--state` | auto-derived | Path to state file tracking ingested message IDs |
| `--interval-ms` | `5000` | Polling interval (watch only) |

### `msgmon gmail`

Direct Gmail operations. All subcommands accept `--account` and `--verbose`.

| Subcommand | Description |
|------------|-------------|
| `gmail auth` | Run OAuth and save token for an account |
| `gmail accounts` | List available token-backed accounts |
| `gmail search <query>` | Search messages; `--fetch=metadata\|full\|summary`, `--format=json\|summary` |
| `gmail count <query>` | Return Gmail's `resultSizeEstimate` for a query |
| `gmail thread <threadId>` | Fetch all messages in a thread; `--format=json\|text` |
| `gmail read <messageId>` | Read one message; `--format=json\|text`, `--save-attachments=DIR` |
| `gmail export` | Export messages to per-message directories (use `ingest --sink=dir` instead) |
| `gmail send` | Send with `--to`, `--cc`, `--bcc`, `--attach`, `--thread-id`, `--yes` (required) |
| `gmail mark-read <id>` | Remove UNREAD label |
| `gmail archive <id>` | Remove INBOX label |

### `msgmon slack`

Direct Slack operations. All subcommands accept `--account` and `--verbose`.

| Subcommand | Description |
|------------|-------------|
| `slack auth` | Store bot token (`--mode=bot`, default) or run OAuth (`--mode=oauth`) |
| `slack accounts` | List configured Slack workspaces |
| `slack search <query>` | Search messages (requires user token with `search:read`) |
| `slack read <channel> <ts>` | Read a single message by channel + timestamp |
| `slack send` | Post a message: `--channel`, `--text`, `--as-user`, `--thread-ts`, `--attach` |

### Multi-platform ingest/watch

Prefix account names with `slack:` to route to the Slack adapter:

```bash
msgmon ingest --account=default --account=slack:myworkspace --query='#general'
msgmon watch --account=slack:myworkspace --query='#general,#engineering' --sink=ndjson
```

For Slack, `--query` accepts comma-separated channel names or IDs (e.g. `#general`, `C01ABC`).

## Configuration

Credentials and tokens are resolved in priority order:

1. `./.msgmon/gmail/credentials.json` (project-local)
2. `<install-dir>/.msgmon/gmail/credentials.json`
3. `~/.msgmon/gmail/credentials.json`

Tokens are read from `<dir>/<platform>/tokens/<account>.json` across all three locations. Auth commands write tokens to `./.msgmon/<platform>/tokens/`.

Slack tokens are stored at `.msgmon/slack/tokens/<account>.json` and contain `bot_token` (always) and optionally `user_token` (from OAuth).

## Architecture

```
msgmon ingest / watch
  │
  ├─ MessageSource (async generator per platform)
  │   ├─ gmailSource → toUnifiedMessage()
  │   └─ slackSource → toUnifiedMessage()
  │
  ├─ Ingest core (multi-account fan-out, state dedup)
  │
  └─ Sink (pluggable output)
      ├─ ndjson → stdout / file
      ├─ dir → unified.json + artifacts per message
      └─ exec → shell command per message

msgmon corpus
  │
  └─ Reads unified.json dirs → messages.jsonl, chunks.jsonl, threads.jsonl
```

All output uses `UnifiedMessage` — a platform-agnostic envelope defined in `src/types.ts`.

## Agent integration

msgmon is designed as infrastructure for LLM agents that process messages. It handles auth, fetching, and sending — the agent decision-making lives outside this tool.

### Cold start: seeding history

On first run, `ingest` would emit every message matching the query as "new." For an agent, this is usually wrong — you want it to start processing from *now*, not re-process 30 days of history.

Use `--seed` to populate the state file without emitting anything:

```bash
# Seed: absorb recent history silently
msgmon ingest --seed --query='newer_than:30d' --max-results=500

# Now run normally — only genuinely new messages come through
msgmon watch --sink=exec --exec-cmd='./agent.sh' --mark-read
```

The seed run records all matching message IDs in the state file. Subsequent runs skip those IDs and only emit messages that arrive after the seed.

### Accessing thread context

When an agent receives a new message (e.g., a reply), it often needs the prior conversation for context. If using `serve`, the agent can call `POST /api/gmail/thread` with the message's `threadId` to fetch the full thread history. This is available without any extra setup — the agent just needs the thread ID from the incoming `UnifiedMessage`.

### Typical serve setup

Run `msgmon serve` in an isolated environment where OAuth credentials live. The agent interacts only via HTTP with a bearer token and never sees the underlying secrets:

```bash
# On the server (has credentials)
msgmon serve --token=agent-secret --gmail-allow-to=allowed@example.com --send-rate-limit=5

# The agent calls endpoints like:
# POST /api/ingest        — poll for new messages
# POST /api/gmail/thread  — fetch thread context
# POST /api/gmail/send    — send a reply (subject to filtering + rate limits)
```

## Adding a new platform

Every platform adapter must satisfy these constraints:

1. **Implement `MessageSource`** (`src/ingest/ingest.ts`). The interface is a single method `listMessages()` returning an `AsyncGenerator<UnifiedMessage>`. This is the only contract the ingest/watch pipeline requires.

2. **Convert to `UnifiedMessage`**. Each platform needs a `toUnifiedMessage()` that maps its native message shape to the unified envelope in `src/types.ts`. Add a corresponding `PlatformMetadata` variant to the discriminated union.

3. **Credential layout**. Follow the three-tier resolution pattern (`pwd → app-install → home`): `.msgmon/<platform>/credentials.json` for app config, `.msgmon/<platform>/tokens/<account>.json` for per-account tokens. Use the helpers in `src/CliConfig.ts` with the `platform` parameter.

4. **Account dispatch**. Register the new source in `resolveSources()` in `src/ingest/cli.ts`. The convention is `<platform>:<account-name>` (e.g. `slack:myworkspace`). Plain names default to mail for backward compatibility.

5. **CLI subcommands**. Provide at minimum: `auth` (store credentials), `accounts` (list configured accounts), `read` (fetch a single message), `send` (post a message). Wire them in `platforms/<platform>/index.ts` and register the yargs command in `cli/index.ts`.

6. **Mark-read**. Implement a `markRead(msg, account)` function and add it to `resolveMarkRead()` in `src/ingest/cli.ts`. If the platform has no read-marking concept, make it a no-op.

7. **Message ID**. Must be stable and unique within the platform scope. Used as the dedup key in the ingest state file.

## Testing

```bash
npm test
```

Runs unit tests for `toUnifiedMessage`, all three sinks, and the ingest core (state management, dedup, multi-account fan-out, markRead).

## Global flags

- `--verbose` / `-v`: print diagnostics to stderr (does not affect stdout JSON shape)

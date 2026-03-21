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

## Quick Start: Agent Setup

The recommended way to run an agent is with three processes across two directories. The **project directory** (where you cloned msgmon) holds credentials and runs the server. The **agent directory** is an isolated folder that receives only workspace data — no secrets, no tokens, no credentials.

```bash
# 1. Install and run interactive setup (project directory)
npm install && npm link
msgmon setup                       # walks through Gmail/Slack auth, workspace creation, action seeding, and context sync

# 2. Start the server (project directory — keeps running)
msgmon serve

# 3. Start the agent session in an isolated directory (separate terminal)
mkdir -p /tmp/agent-sandbox
msgmon session start \
  --workspace=default \
  --dir=/tmp/agent-sandbox \
  --watch \
  --agent-command='codex .'
```

The `--dir` flag places the agent's working copy outside the project tree. The agent sees only the workspace snapshot files (`inbox/`, `context/`, `workspace.json`, `instructions.md`, `drafts/`, etc.) and a `.msgmon-session/` folder with sync metadata. It never sees OAuth tokens, `credentials.json`, or `serve.json`.

New messages reach the agent through periodic refresh. Either:

- Run `msgmon workspace refresh default` on a cron / in a loop, or
- Have the agent call `POST /api/workspace/refresh` via the server API

The `--watch` flag on `session start` syncs file changes between the server and agent directory on an interval, so refreshed messages appear automatically.

To add more accounts later, re-run `msgmon setup` — it skips completed steps and prompts to add additional Gmail or Slack accounts.

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

### `msgmon draft`

Workspace-owned draft management. Compose messages targeting any platform, review them, and send when ready. Drafts live as flat JSON files under `.msgmon/workspaces/<workspaceId>/drafts/` and every draft command requires `--workspace`.

```bash
# Compose a gmail draft (reply to a thread)
msgmon draft compose --workspace=inbox-agent --platform=gmail --to=alice@example.com --subject="Re: Project" \
  --body="Sounds good" --thread-id=18f3a... --in-reply-to="<abc@example.com>"

# Compose a slack draft
msgmon draft compose --workspace=inbox-agent --platform=slack --channel='#general' --text="Weekly update" --attach=./report.pdf

# List, show, edit, send, delete
msgmon draft list --workspace=inbox-agent --format=text
msgmon draft show <id> --workspace=inbox-agent
msgmon draft edit <id> --workspace=inbox-agent --body="Updated body"
msgmon draft send <id> --workspace=inbox-agent --yes
msgmon draft delete <id> --workspace=inbox-agent
```

Draft IDs support prefix matching — `msgmon draft show abc` matches a draft whose ID starts with `abc`.

### `msgmon corpus`

Build an LLM-oriented corpus from ingested message directories. Platform-agnostic.

```bash
msgmon corpus --from=./inbox --out-dir=./corpus
msgmon corpus --from=./inbox --out-dir=./corpus --chunk-chars=8000
```

Outputs `messages.jsonl`, `chunks.jsonl`, `threads.jsonl`, and `summary.json`.

### `msgmon workspace`

Server-managed workspace lifecycle. Workspaces live under `.msgmon/workspaces/<id>` and are intended to be exported into isolated agent runtimes as plain files, without exposing local OAuth tokens or unrestricted send capability.

```bash
msgmon workspace init inbox-agent --account=default --query='in:inbox category:primary is:unread'
msgmon workspace refresh inbox-agent --max-results=100
msgmon workspace context-sync inbox-agent --since=2026-03-01
msgmon workspace show inbox-agent
msgmon workspace list
```

Each workspace contains:

- `workspace.json` — workspace metadata and ingest config
- `instructions.md` — agent operating instructions
- `user-profile.md` — user context and preferences
- `status.md` — agent-maintained working summary
- `inbox/` — newly ingested actionable message JSON files
- `context/` — system-managed historical reference message JSON files
- `drafts/` — draft JSON files that can later be sent through `serve`

### `msgmon serve`

HTTP API server that exposes msgmon as a secret-holding control plane with token authentication. The intended model is: `serve` owns credentials, ingest, and outbound policy; the agent gets a workspace snapshot as files in an isolated runtime and uses the API only for privileged actions.

```bash
msgmon serve --token=mysecret
msgmon serve --token=mysecret --port=8080 --host=0.0.0.0
msgmon serve --token=mysecret --gmail-allow-to=a@x.com,b@x.com --send-rate-limit=10
msgmon serve --token=mysecret --slack-allow-channels=general,alerts
msgmon serve --scoped-token=reader=read,workspace_read --scoped-token=writer=workspace_write,drafts
msgmon serve
```

Every request must include the header `X-Auth-Token: <token>`. All endpoints accept `POST` with a JSON body and return `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`. Request bodies are validated with Zod.

**Token capabilities:**
- `--token` creates a full-access token.
- `--scoped-token=<token>=<cap1>,<cap2>` creates a restricted token.
- Available capabilities: `read`, `ingest`, `drafts`, `send`, `workspace_read`, `workspace_write`, `workspace_actions`.
- If you omit both `--token` and `--scoped-token`, `serve` generates a secure random full-access token and saves local connection info to `./.msgmon/serve.json`.
- Discovery endpoints:
  - `GET /.well-known/llms.txt`
  - `GET /api/agent/manifest`

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
| `POST /api/draft/compose` | Create a draft (`{ workspaceId, platform, to\|channel, ... }`) |
| `POST /api/draft/list` | List drafts (`{ workspaceId, platform? }`) |
| `POST /api/draft/show` | Show a draft (`{ workspaceId, id }`) |
| `POST /api/draft/update` | Update draft fields (`{ workspaceId, id, ...fields }`) |
| `POST /api/draft/send` | Send a draft (`{ workspaceId, id, keep? }`) |
| `POST /api/draft/delete` | Delete a draft (`{ workspaceId, id }`) |
| `POST /api/workspace/export` | Export agent-safe workspace snapshot or bundle (`{ workspaceId, format? }`) |
| `POST /api/workspace/bootstrap` | Create a workspace (`{ workspaceId, name?, accounts?, query?, overwrite? }`) |
| `POST /api/workspace/import` | Import a bundled workspace (`{ workspaceId?, bundleBase64, overwrite? }`) |
| `POST /api/workspace/refresh` | Ingest new inbox messages and optionally sync historical context (`{ workspaceId, maxResults?, markRead?, saveAttachments?, seed?, syncContext?, contextMaxResults?, contextSince?, clearContext? }`) |
| `POST /api/workspace/push` | Push bounded file edits (`{ workspaceId, baseRevision, files[] }`) |
| `POST /api/workspace/actions` | Apply privileged workspace actions (`{ workspaceId, actions[] }`) |
| `GET /.well-known/llms.txt` | Human-readable bootstrap instructions for coding agents |
| `GET /api/agent/manifest` | Structured bootstrap manifest for coding agents |
| `GET /api/health` | Health check (returns `{ status: "ok", uptime }`) |

**Attachments** (for `/api/gmail/send` and `/api/slack/send`): pass an `attachments` array in the JSON body. Each attachment is `{ filename, data, contentType? }` where `data` is base64-encoded file content. Slack file uploads require the `files:write` bot/user scope.

**Workspace sync model:**
- `/api/workspace/export` returns either a JSON snapshot or a gzip-compressed bundle export.
- `/api/workspace/bootstrap` creates a new server-owned workspace.
- `/api/workspace/import` imports a previously exported bundle into a new or existing workspace.
- `/api/workspace/push` accepts bounded changes back for writable files such as `status.md` and `drafts/*.json`.
- `/api/workspace/actions` is the policy gate for privileged operations such as sending drafts, marking messages read, and archiving Gmail.
- Hidden server files such as state and workspace-local credentials are not included in exports.

### `msgmon sync`

Client-side filesystem sync for isolated agent runtimes. This mirrors a server-owned workspace into a local directory, keeps session metadata under `.msgmon-session/`, and lets the agent work directly on files.

```bash
msgmon sync pull --server=http://127.0.0.1:3271 --token=reader --workspace=inbox-agent
msgmon sync push --workspace=inbox-agent
msgmon sync watch --server=http://127.0.0.1:3271 --token=reader --workspace=inbox-agent
```

By default the local mirror lives at `./.msgmon/agent/<workspace>/`. `pull` refuses to overwrite locally modified writable files unless `--force` is passed. `push` sends only bounded writable paths back to the server: `status.md`, `instructions.md`, `user-profile.md`, and `drafts/**`.
`watch` automatically pushes bounded local file changes before each pull cycle unless you pass `--no-auto-push`.

### `msgmon session`

Bootstrap helper for the “one command” terminal workflow. It performs an initial sync, optionally starts a detached watcher, and can launch a coding-agent command inside the synced directory.

```bash
msgmon session start \
  --workspace=inbox-agent \
  --agent-command='codex .'
```

Session metadata lives under `./.msgmon/agent/<workspace>/.msgmon-session/`. Use:

```bash
msgmon session status --workspace=inbox-agent
msgmon session stop --workspace=inbox-agent
```

### Sinks

Both `ingest` and `watch` support three output sinks:

| Sink | Flag | Description |
|------|------|-------------|
| **ndjson** | `--sink=ndjson` (default) | One `UnifiedMessage` JSON per line to stdout. Pipe-friendly. |
| **dir** | `--sink=dir --out-dir=PATH` | One JSON file per message: `<timestamp>_<id>.json`. |
| **exec** | `--sink=exec --exec-cmd=CMD` | Run a shell command per message with `MSGMON_*` env vars and `MSGMON_JSON`. |

### Shared ingest/watch flags

| Flag | Default | Description |
|------|---------|-------------|
| `--account` | `default` | Account name(s), repeatable/comma-separated |
| `--query` | `in:inbox category:primary is:unread` | Platform-native search query |
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

1. `./.msgmon/<platform>/credentials.json` (project-local)
2. `<install-dir>/.msgmon/<platform>/credentials.json`
3. `~/.msgmon/<platform>/credentials.json`

Tokens are read from `<dir>/<platform>/tokens/<account>.json` across all three locations. Auth commands write tokens to `./.msgmon/<platform>/tokens/`. There is no flat legacy fallback under `./.msgmon/credentials.json` or `./.msgmon/tokens/`.

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

### Trust model

The secure operating model is:

1. Run `msgmon serve` in the trusted environment that holds credentials.
2. Create a workspace with `msgmon workspace init`.
3. Refresh that workspace on the server with `msgmon workspace refresh` or `POST /api/workspace/refresh`.
4. Let the agent discover the server via `GET /.well-known/llms.txt` and `GET /api/agent/manifest`.
5. Mirror the workspace into an isolated local directory with `msgmon sync pull`.
6. Let the agent read and edit the local files freely.
7. Push allowed file changes back with `msgmon sync push` or `POST /api/workspace/push`.
8. Route all privileged actions such as sending, mark-read, and archive through `POST /api/workspace/actions` or other `serve` endpoints.

This keeps the agent file-native while keeping secrets and outbound policy on the server side.

### Cold start: seed now, sync context separately

On first run, `ingest` would emit every message matching the query as "new." For an agent, this is usually wrong. You want the action boundary to start from *now*, while still letting the agent read recent history for context.

Use `--seed` to populate the state file without emitting anything:

```bash
# Seed: absorb recent history silently
msgmon ingest --seed --query='newer_than:30d' --max-results=500

# Sync historical reference material into workspace/context
msgmon workspace context-sync inbox-agent --since=2026-03-01

# Now refresh the actionable inbox normally
msgmon workspace refresh inbox-agent --mark-read
```

The seed run records the action boundary in the state file. Historical backfills go into `context/`, while subsequent refresh runs only write genuinely new actionable messages into `inbox/`.

### Accessing thread context

When an agent receives a new message, it often needs the prior conversation for context. If using `serve`, the agent can call `POST /api/gmail/thread` with the message's `threadId` to fetch full thread history without needing direct Gmail credentials.

### Typical serve setup

Run `msgmon serve` in the trusted environment where OAuth credentials live. The agent interacts only with exported workspace files plus the HTTP API and never sees the underlying secrets:

```bash
# On the server (has credentials)
msgmon workspace init inbox-agent --account=default --query='in:inbox category:primary is:unread'
msgmon workspace refresh inbox-agent
msgmon serve \
  --scoped-token=reader=read,workspace_read \
  --scoped-token=writer=workspace_write,drafts \
  --scoped-token=actor=workspace_actions \
  --gmail-allow-to=allowed@example.com \
  --send-rate-limit=5

# In the isolated agent runtime:
msgmon session start \
  --workspace=inbox-agent \
  --agent-command='codex .'

# Then push local edits back with:
msgmon sync push --workspace=inbox-agent

# And use:
# POST /api/workspace/actions  — ask the server to send or mutate remote state
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

Runs unit tests for `toUnifiedMessage`, the sinks, ingest state/dedup behavior, and the server-managed workspace sync model.

## Global flags

- `--verbose` / `-v`: print diagnostics to stderr (does not affect stdout JSON shape)

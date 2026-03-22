# msgmon

Multi-account message ingestion CLI for Gmail and Slack. Designed as infrastructure for LLM agents that process messages — msgmon handles auth, fetching, and sending while agent decision-making lives outside the tool.

## Install

```bash
npm install
npm link
msgmon --help
```

## Quick Start

msgmon uses a server/client directory model:

- A **server workspace** holds `inbox/`, `context/`, `drafts/`, `status.md`, `AGENTS.md`, and a hidden `.msgmon/` folder for secrets and state.
- A **client** directory receives an agent-safe mirror — no credentials exposed.

```bash
# 1. Set up a server workspace (walks through account auth)
msgmon setup ./workspace

# 2. Start the server
msgmon serve ./workspace

# 3. Start an agent client
msgmon client start \
  --server=http://127.0.0.1:3271 \
  --dir=/tmp/agent-sandbox \
  --watch \
  --agent-command='codex .'
```

The agent sees only exported files plus `.msgmon-session/` sync metadata. New messages arrive via periodic refresh — either `msgmon server refresh ./workspace` on a cron, or `POST /api/workspace/refresh` through the server.

To add more accounts later, re-run `msgmon setup` — it skips completed steps and prompts for new ones.

## Gmail Setup

1. In Google Cloud, enable the Gmail API, configure OAuth consent, and create an OAuth Client ID (Desktop app).
2. Save the client JSON as `.msgmon/gmail/credentials.json`.
3. Authorize:

```bash
msgmon gmail auth --account=personal
msgmon gmail accounts   # verify
```

Requested scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`.

## Slack Setup

### Bot token (simplest)

1. Create a Slack app at https://api.slack.com/apps.
2. Add bot scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `mpim:history`, `users:read`, `chat:write`.
3. Install to your workspace, then:

```bash
msgmon slack auth --token=xoxb-... --account=myworkspace
```

### OAuth (enables send-as-user and search)

1. Save `client_id` and `client_secret` to `.msgmon/slack/credentials.json`.
2. Run `msgmon slack auth --mode=oauth --account=myworkspace`.

## Commands

### `msgmon ingest`

One-shot scan: emit new messages to a sink, then exit. Safe for cron.

```bash
msgmon ingest --account=work --sink=dir --out-dir=./inbox --save-attachments
msgmon ingest --sink=ndjson > today.jsonl
msgmon ingest --sink=exec --exec-cmd='./handle.sh' --mark-read
```

### `msgmon watch`

Daemon mode: continuously poll and emit new messages.

```bash
msgmon watch --account=work --sink=ndjson | my-router
msgmon watch --sink=dir --out-dir=/data/inbox --interval-ms=10000
```

Both `ingest` and `watch` support three sinks: `ndjson` (stdout, default), `dir` (one JSON file per message), and `exec` (shell command per message with `MSGMON_*` env vars).

### `msgmon draft`

Compose, review, and send messages from any platform.

```bash
msgmon draft compose --platform=gmail --to=alice@example.com --subject="Re: Project" \
  --body="Sounds good" --thread-id=18f3a...
msgmon draft compose --platform=slack --channel='#general' --text="Weekly update"
msgmon draft list
msgmon draft send <id> --yes
```

Draft IDs support prefix matching.

### `msgmon server`

Directory-based server workspace lifecycle.

```bash
msgmon server init ./workspace --account=default --query='in:inbox category:primary is:unread'
msgmon server refresh ./workspace
msgmon server context-sync ./workspace --since=2026-03-01
msgmon server show ./workspace
```

Server workspaces contain:
- `inbox/` — new actionable messages
- `context/` — historical reference messages
- `drafts/` — draft JSON files
- `workspace.json`, `AGENTS.md`, `status.md`

On first setup, `msgmon setup` bootstraps history into `context/` and seeds the inbox boundary so old unread messages don't flood `inbox/`. After that, `refresh` only pulls new items while `context-sync` backfills history on demand.

### `msgmon serve`

HTTP server that acts as a secret-holding control plane with token auth.

```bash
msgmon serve ./workspace --token=mysecret
msgmon serve ./workspace --gmail-allow-to=a@x.com --slack-allow-channels=general --send-rate-limit=10
msgmon serve ./workspace \
  --scoped-token=reader=read,workspace_read \
  --scoped-token=writer=workspace_write,drafts
```

If you omit `--token` and `--scoped-token`, a secure random token is generated and saved to `.msgmon/serve.json`.

Scoped token capabilities: `read`, `ingest`, `drafts`, `send`, `workspace_read`, `workspace_write`, `workspace_actions`.

All endpoints accept `POST` with JSON body and require `X-Auth-Token` header. Discovery is available at `GET /.well-known/llms.txt` and `GET /api/agent/manifest`.

### `msgmon client`

Filesystem sync for isolated agent runtimes.

```bash
msgmon client start --server=http://127.0.0.1:3271 --dir=/tmp/agent-sandbox --agent-command='codex .'
msgmon client pull --server=http://127.0.0.1:3271 --dir=/tmp/agent-sandbox
msgmon client push --dir=/tmp/agent-sandbox
msgmon client status --dir=/tmp/agent-sandbox
msgmon client stop --dir=/tmp/agent-sandbox
```

`push` sends only bounded writable paths back to the server: `AGENTS.md`, `status.md`, and `drafts/**`. The `--watch` flag on `start` syncs changes on an interval.

### `msgmon gmail` / `msgmon slack`

Direct platform operations: `auth`, `accounts`, `search`, `read`, `send`, `thread` (Gmail), `mark-read` (Gmail), `archive` (Gmail).

```bash
msgmon gmail search "from:billing@example.com" --account=personal
msgmon gmail thread <threadId>
msgmon gmail send --to=alice@example.com --subject="Hi" --body="Hello" --yes
msgmon slack search "quarterly report" --account=myworkspace
msgmon slack send --channel='#general' --text="Update posted"
```

### Multi-platform ingest

Prefix account names with `slack:` to mix platforms:

```bash
msgmon ingest --account=default --account=slack:myworkspace --query='#general'
```

## Configuration

Credentials are resolved in priority order:

1. `./.msgmon/<platform>/credentials.json` (project-local)
2. `<install-dir>/.msgmon/<platform>/credentials.json`
3. `~/.msgmon/<platform>/credentials.json`

Tokens live at `.msgmon/<platform>/tokens/<account>.json` across all three locations.

## Global Flags

- `--verbose` / `-v`: print diagnostics to stderr

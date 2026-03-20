# messagemon

Multi-account message ingestion CLI. Currently supports Gmail; Slack, Teams, and WhatsApp adapters are planned.

## Install

```bash
npm install
npm link
messagemon --help
```

To remove the global link:

```bash
npm unlink -g messagemon
```

## Gmail Setup (OAuth)

1. In Google Cloud, create/select a project, enable `Gmail API`, configure the OAuth consent screen, and create an OAuth Client ID (Desktop app).
2. Save the client JSON as `.messagemon/mail/credentials.json` (or `~/.messagemon/mail/credentials.json`).
3. Authorize an account:

```bash
messagemon mail auth --account=personal
```

4. Verify:

```bash
messagemon mail accounts --format=text
messagemon mail search "in:inbox is:unread" --account=personal
```

The tool requests scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`.

## Commands

### `messagemon ingest`

One-shot: scan accounts, emit new messages to a sink, then exit. Safe to run from cron.

```bash
messagemon ingest --account=work --account=personal --sink=dir --out-dir=./inbox --save-attachments
messagemon ingest --sink=ndjson > today.jsonl
messagemon ingest --sink=exec --exec-cmd='./handle.sh' --mark-read
messagemon ingest --query='from:billing@example.com' --state=./state.json
```

### `messagemon watch`

Daemon: continuously poll and emit new messages as they arrive.

```bash
messagemon watch --account=work --sink=ndjson | my-router
messagemon watch --sink=dir --out-dir=/data/inbox --save-attachments --interval-ms=10000
messagemon watch --sink=exec --exec-cmd='./agent.sh' --mark-read
```

### Sinks

Both `ingest` and `watch` support three output sinks:

| Sink | Flag | Description |
|------|------|-------------|
| **ndjson** | `--sink=ndjson` (default) | One `UnifiedMessage` JSON per line to stdout. Pipe-friendly. |
| **dir** | `--sink=dir --out-dir=PATH` | One directory per message: `unified.json`, `body.txt`, `body.html`, `headers.json`, `attachments/`. |
| **exec** | `--sink=exec --exec-cmd=CMD` | Run a shell command per message with `MESSAGEMON_*` env vars and `MESSAGEMON_JSON`. |

### Shared ingest/watch flags

| Flag | Default | Description |
|------|---------|-------------|
| `--account` | `default` | Account name(s), repeatable/comma-separated |
| `--query` | `is:unread` | Platform-native search query |
| `--max-results` | `100` | Max messages per account per cycle |
| `--mark-read` | `false` | Mark messages as read after ingestion |
| `--save-attachments` | `false` | Download attachments (dir sink only) |
| `--state` | auto-derived | Path to state file tracking ingested message IDs |
| `--interval-ms` | `5000` | Polling interval (watch only) |

### `messagemon mail`

Direct Gmail operations. All subcommands accept `--account` and `--verbose`.

| Subcommand | Description |
|------------|-------------|
| `mail auth` | Run OAuth and save token for an account |
| `mail accounts` | List available token-backed accounts |
| `mail search <query>` | Search messages; `--fetch=metadata\|full\|summary`, `--format=json\|summary` |
| `mail count <query>` | Return Gmail's `resultSizeEstimate` for a query |
| `mail thread <threadId>` | Fetch all messages in a thread; `--format=json\|text` |
| `mail read <messageId>` | Read one message; `--format=json\|text`, `--save-attachments=DIR` |
| `mail export` | Export messages to per-message directories (legacy, use `ingest --sink=dir` instead) |
| `mail corpus` | Build LLM corpus (`messages.jsonl`, `chunks.jsonl`, `threads.jsonl`) from export or ingest directories |
| `mail send` | Send with `--to`, `--cc`, `--bcc`, `--attach`, `--thread-id`, `--yes` (required) |
| `mail mark-read <id>` | Remove UNREAD label |
| `mail archive <id>` | Remove INBOX label |

## Configuration

Credentials and tokens are resolved in priority order:

1. `./.messagemon/mail/credentials.json` (project-local)
2. `<install-dir>/.messagemon/mail/credentials.json`
3. `~/.messagemon/mail/credentials.json`

Tokens are read from `<dir>/mail/tokens/<account>.json` across all three locations. `mail auth` writes tokens to `./.messagemon/mail/tokens/`.

## Architecture

```
messagemon ingest / watch
  │
  ├─ MessageSource (async generator per platform)
  │   └─ mailSource → toUnifiedMessage()
  │
  ├─ Ingest core (multi-account fan-out, state dedup)
  │
  └─ Sink (pluggable output)
      ├─ ndjson → stdout / file
      ├─ dir → unified.json + artifacts per message
      └─ exec → shell command per message
```

All output uses `UnifiedMessage` — a platform-agnostic envelope defined in `src/types.ts`.

## Testing

```bash
npm test
```

Runs unit tests for `toUnifiedMessage`, all three sinks, and the ingest core (state management, dedup, multi-account fan-out, markRead).

## Global flags

- `--verbose` / `-v`: print diagnostics to stderr (does not affect stdout JSON shape)

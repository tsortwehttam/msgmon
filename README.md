# mailmon

`mailmon` is a Gmail CLI for account auth, account discovery, message search/read, message sending, and continuous monitoring that can invoke an agent per message.

## Install

To install this repo as a global command on your machine:

```bash
npm link
```

Then run:

```bash
mailmon --help
```

To remove the global link later:

```bash
npm unlink -g mailmon
```

## Gmail Setup (OAuth)

`mailmon` uses Gmail API OAuth (not IMAP/SMTP app passwords).

1. In Google Cloud, create/select a project, enable `Gmail API`, configure the OAuth consent screen, and create an OAuth Client ID (Desktop app is the simplest choice).
2. Download the client JSON and save it as one of:
   - `./.mailmon/credentials.json` (preferred)
   - `~/.mailmon/credentials.json`
3. Run auth to create a token for an account name:

```bash
mailmon auth --account=personal
```

4. Verify access:

```bash
mailmon accounts --format=text
mailmon mail --account=personal search "in:inbox is:unread"
```

Notes:
- If your OAuth app is in testing mode, add your Gmail address as a test user.
- The tool requests these scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`.

## Configuration Resolution

`mailmon` supports both local project config and global home config.

- Credentials path resolution:
  - `./.mailmon/credentials.json` (current working directory, preferred if present)
  - `<mailmon-install-dir>/.mailmon/credentials.json`
  - `~/.mailmon/credentials.json` (fallback)
- Token read locations:
  - `./.mailmon/tokens/*.json` (current working directory)
  - `<mailmon-install-dir>/.mailmon/tokens/*.json`
  - `~/.mailmon/tokens/*.json`
- Token write location (`mailmon auth`):
  - `./.mailmon/tokens/` in the current working directory

Accounts are token filenames without `.json` (for example `.mailmon/tokens/personal.json` => account `personal`).

## Top-Level Usage

```bash
mailmon --help
mailmon help
mailmon help mail
mailmon help auth
mailmon help accounts
mailmon help poll
mailmon help monitor
```

Top-level commands:

- `mailmon mail ...`
- `mailmon auth ...`
- `mailmon accounts ...`
- `mailmon poll ...`
- `mailmon monitor ...`

Global flag:

- `--verbose` / `-v`: print diagnostic information to `stderr`

## Command Reference

### `mailmon auth`

Runs OAuth and writes a token for an account.

```bash
mailmon auth --account=personal
```

Output:

- prints `Saved <absolute-path-to-token>`

### `mailmon accounts`

Lists token-backed accounts available from pwd/install-dir/home token directories.

```bash
mailmon accounts --format=json
mailmon accounts --format=text
```

Output contract:

- `json` (default): JSON array of account names
- `text`: one account per line

### `mailmon mail`

Subcommands:

- `search <query>`
- `read <messageId>`
- `mark-read <messageId>`
- `archive <messageId>`
- `send`

#### Search

```bash
mailmon mail --account=personal search "from:alerts@example.com newer_than:7d"
mailmon mail --account=personal search "in:inbox is:unread" --fetch metadata
```

Output:

- JSON array of Gmail message references (`id`, `threadId`, etc.)
- With `--fetch metadata|full`, returns:
  - `{ query, messages, resolvedMessages }`

Important search flags:

- `--max-results` maximum matched messages to return (default `20`)
- `--fetch` optional hydration mode: `none` (default), `metadata`, or `full`

#### Read

```bash
mailmon mail --account=personal read 190cf9f55b05efcc
```

Output:

- JSON object with message metadata and headers (`From`, `To`, `Subject`, `Date`)

#### Send

Minimal send:

```bash
mailmon mail --account=personal send \
  --to you@example.com \
  --subject "Hi" \
  --body "Hello" \
  --yes
```

Reply/thread example:

```bash
mailmon mail --account=personal send \
  --to you@example.com \
  --subject "Re: Status" \
  --body "Following up" \
  --thread-id 190cb53f30f3d1aa \
  --in-reply-to "<original@message.id>" \
  --references "<original@message.id>" \
  --reply-to replies@example.com \
  --yes
```

Attachments/recipient example:

```bash
mailmon mail --account=personal send \
  --to you@example.com \
  --cc team@example.com \
  --bcc audit@example.com \
  --subject "Report" \
  --body "Attached" \
  --attach ./report.pdf \
  --attach ./metrics.csv \
  --yes
```

Important send flags:

- `--yes` required safety flag (send is refused without it)
- `--to` required
- `--cc`, `--bcc`, `--attach` support repeated and comma-separated values
- `--thread-id` sets Gmail API thread routing
- `--in-reply-to` / `--references` set RFC 5322 threading headers
- `--from` optional `From` header (must be authorized in Gmail sender settings)
- `--message-id` optional Message-ID override

Output:

- JSON send response from Gmail API (includes fields such as `id`, `threadId`)

#### Mark Read

```bash
mailmon mail --account=personal mark-read 190cf9f55b05efcc
```

Output:

- JSON message object after update (includes fields such as `id`, `threadId`, `labelIds`)

#### Archive

```bash
mailmon mail --account=personal archive 190cf9f55b05efcc
```

Output:

- JSON message object after update (includes fields such as `id`, `threadId`, `labelIds`)

### `mailmon poll`

Polls for Gmail query matches (default query: `is:unread`) until at least one message exists, then emits JSON and exits.

```bash
mailmon poll --account=personal
mailmon poll --query "in:inbox is:unread"
mailmon poll --query "category:promotions is:unread"
mailmon poll --query "in:inbox is:unread" --fetch metadata
mailmon poll --query "in:inbox is:unread" --fetch full
mailmon poll --query "in:inbox is:unread" --exit-when any-match
mailmon poll --interval-ms=2000 --out ./tmp/unread.json
```

Pipe-friendly example:

```bash
mailmon poll --account=personal | jq '.messages[].id'
```

Important poll flags:

- `--interval-ms` polling interval in milliseconds (default `5000`)
- `--max-results` max matched messages returned once found (default `20`)
- `--query` Gmail search query to poll for (default `is:unread`)
- `--fetch` optional hydration mode: `none` (default), `metadata`, or `full`
- `--exit-when` poll exit condition. Current value: `any-match` (exit when one or more matches are found)
- `--out` optional file path to also write the same JSON payload

Output:

- One JSON object to `stdout` when the exit condition is met, then process exits.
- JSON shape: `{ polledAt, account, query, exitWhen, messages, resolvedMessages? }`

### `mailmon monitor`

Continuously polls Gmail query matches and, for each newly seen message id, creates a run directory and executes your agent command in that directory.

```bash
mailmon monitor \
  --account=personal \
  --query "in:inbox is:unread" \
  --agent-cmd 'codex run "Read TASK.md and process this message."'
```

Prompt and AGENTS.md example:

```bash
mailmon monitor \
  --agent-cmd './my-agent.sh' \
  --prompt-file ./prompt.md \
  --agents-md ./AGENTS.md
```

Per-message run directory contents:

- `message.json` full Gmail payload
- `headers.json` header map
- `body.txt` and/or `body.html`
- `attachments/` extracted attachment files
- `TASK.md` with your prompt and processing instructions

Important monitor flags:

- `--agent-cmd` required shell command to run per message
- `--query` Gmail query to watch (default `is:unread`)
- `--interval-ms` polling interval (default `5000`)
- `--work-root` parent directory for per-message run folders (default system temp dir `/mailmon`)
- `--state` state file path tracking processed message ids
- `--prompt` inline task prompt text
- `--prompt-file` load task prompt text from a file
- `--agents-md` optional AGENTS.md copied into each run folder
- `--mark-read` optionally remove `UNREAD` label after successful agent execution

## Agent-Friendly Notes

- `mail` commands emit JSON responses suitable for automation.
- `accounts` emits JSON by default.
- `--verbose` writes diagnostics to `stderr` and does not change JSON payload shape.

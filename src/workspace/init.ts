import fs from "node:fs"
import path from "node:path"

export interface WorkspaceConfig {
  name: string
  accounts: string[]
  query: string
  watchIntervalMs: number
  onMessage?: string
  createdAt: string
}

let WORKSPACE_DIRS = ["inbox", "drafts", "corpus"] as const

let DEFAULT_INSTRUCTIONS = `# Agent Instructions

You are an AI assistant managing a message inbox on behalf of the user.

## Responsibilities

1. **Monitor incoming messages** — as new messages arrive in \`inbox/\`, read and understand them.
2. **Maintain status.md** — keep it up to date with:
   - A summary of unread/unprocessed messages
   - Action items and decisions needed
   - Draft responses ready for review
3. **Pre-compose drafts** — for messages that need a response, create draft replies
   in \`drafts/\` using \`msgmon draft compose\`. Follow the tone and rules below.
4. **Update as context changes** — when new messages make earlier items moot,
   remove or update the corresponding notes and drafts.

## Tone & Style

- Professional but concise
- Match the formality level of the sender
- Default to brevity — say what needs to be said, nothing more

## Briefing Protocol

When the user says "brief me":
1. Walk through each item in status.md
2. Present draft responses for approval
3. For each draft, accept: send, edit, drop, or wait
4. Take action accordingly (send via \`msgmon draft send\`, delete, or hold)

## Rules

- Never send a message without explicit user approval
- Flag anything urgent at the top of status.md
- Group related messages by thread/topic
`

let DEFAULT_USER_PROFILE = `# User Profile

<!-- Fill in your details so the agent can personalize responses -->

Name:
Role:
Organization:

## Key Contacts

<!-- List people the agent should recognize and how to address them -->
<!-- - Jane Doe (jane@example.com) — manager, address formally -->

## Preferences

<!-- Response preferences, working hours, priority rules, etc. -->
- Working hours: 9am–6pm
- Urgent = needs response within 1 hour
- Low priority = newsletters, notifications, FYI-only threads
`

let DEFAULT_STATUS = `# Status

> This file is maintained by the agent. Last updated: never

## Urgent

_Nothing urgent._

## Action Items

_No pending action items._

## Draft Responses

_No drafts pending review._

## Summary

_No messages processed yet._
`

let DEFAULT_ON_MESSAGE = `#!/usr/bin/env bash
# on-message.sh — called by "msgmon workspace watch" for each new message.
#
# Environment variables available:
#   MSGMON_WORKSPACE  — absolute path to the workspace root
#   MSGMON_ID         — message ID
#   MSGMON_PLATFORM   — gmail, slack, etc.
#   MSGMON_TIMESTAMP  — ISO-8601 timestamp
#   MSGMON_SUBJECT    — subject line (email) or synthesized
#   MSGMON_FROM       — sender address
#   MSGMON_THREAD_ID  — thread/conversation ID
#   MSGMON_JSON       — full UnifiedMessage as JSON
#   MSGMON_MSG_DIR    — directory where the message was saved (inbox/<dir>)
#
# This script is a starting point. Replace it with your agent invocation.
# Example: pipe the message into an LLM agent that updates status.md

set -euo pipefail

echo "[on-message] New message from $MSGMON_FROM: $MSGMON_SUBJECT" >&2

# Example: invoke your agent CLI here
# my-agent process \\
#   --workspace "$MSGMON_WORKSPACE" \\
#   --message "$MSGMON_MSG_DIR/unified.json" \\
#   --instructions "$MSGMON_WORKSPACE/instructions.md" \\
#   --status "$MSGMON_WORKSPACE/status.md"
`

export let initWorkspace = (targetDir: string, options: { name?: string; accounts?: string[]; query?: string } = {}) => {
  let resolved = path.resolve(targetDir)

  if (fs.existsSync(resolved)) {
    let entries = fs.readdirSync(resolved)
    if (entries.length > 0) {
      throw new Error(`Directory "${resolved}" already exists and is not empty`)
    }
  }

  fs.mkdirSync(resolved, { recursive: true })

  for (let dir of WORKSPACE_DIRS) {
    fs.mkdirSync(path.join(resolved, dir), { recursive: true })
  }

  let config: WorkspaceConfig = {
    name: options.name ?? path.basename(resolved),
    accounts: options.accounts ?? ["default"],
    query: options.query ?? "is:unread",
    watchIntervalMs: 5000,
    onMessage: "./on-message.sh",
    createdAt: new Date().toISOString(),
  }

  fs.writeFileSync(path.join(resolved, "workspace.json"), JSON.stringify(config, null, 2) + "\n")
  fs.writeFileSync(path.join(resolved, "instructions.md"), DEFAULT_INSTRUCTIONS)
  fs.writeFileSync(path.join(resolved, "user-profile.md"), DEFAULT_USER_PROFILE)
  fs.writeFileSync(path.join(resolved, "status.md"), DEFAULT_STATUS)

  let hookPath = path.join(resolved, "on-message.sh")
  fs.writeFileSync(hookPath, DEFAULT_ON_MESSAGE)
  fs.chmodSync(hookPath, 0o755)

  return { path: resolved, config }
}

export let loadWorkspaceConfig = (workspaceDir: string): WorkspaceConfig => {
  let configPath = path.join(path.resolve(workspaceDir), "workspace.json")
  if (!fs.existsSync(configPath)) {
    throw new Error(`Not a workspace: ${configPath} not found`)
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"))
}

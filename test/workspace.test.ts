import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initWorkspace, loadWorkspaceConfig } from "../src/workspace/init"
import { createChainSink } from "../src/ingest/sinks"
import { createWorkspaceHookSink } from "../src/workspace/hook"
import type { UnifiedMessage } from "../src/types"

let tmpDir: string

let makeMsg = (id: string): UnifiedMessage => ({
  id,
  platform: "gmail",
  timestamp: "2024-01-15T10:30:00.000Z",
  subject: `Subject ${id}`,
  bodyText: `Body ${id}`,
  from: { address: "sender@example.com" },
  to: [{ address: "recipient@example.com" }],
  threadId: `thread-${id}`,
  platformMetadata: {
    platform: "gmail",
    messageId: id,
    threadId: `thread-${id}`,
    labelIds: [],
    headers: {},
  },
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msgmon-workspace-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("workspace init", () => {
  it("creates all expected files and directories", () => {
    let wsDir = path.join(tmpDir, "my-workspace")
    let result = initWorkspace(wsDir)

    assert.equal(result.path, wsDir)
    assert.equal(result.config.name, "my-workspace")
    assert.deepEqual(result.config.accounts, ["default"])
    assert.equal(result.config.query, "is:unread")

    // Directories
    assert.ok(fs.statSync(path.join(wsDir, "inbox")).isDirectory())
    assert.ok(fs.statSync(path.join(wsDir, "drafts")).isDirectory())
    assert.ok(fs.statSync(path.join(wsDir, "corpus")).isDirectory())

    // Files
    assert.ok(fs.existsSync(path.join(wsDir, "workspace.json")))
    assert.ok(fs.existsSync(path.join(wsDir, "instructions.md")))
    assert.ok(fs.existsSync(path.join(wsDir, "user-profile.md")))
    assert.ok(fs.existsSync(path.join(wsDir, "status.md")))
    assert.ok(fs.existsSync(path.join(wsDir, "on-message.sh")))
  })

  it("on-message.sh is executable and contains hook template", () => {
    let wsDir = path.join(tmpDir, "hook-check")
    initWorkspace(wsDir)

    let hookPath = path.join(wsDir, "on-message.sh")
    let stat = fs.statSync(hookPath)
    // Check executable bit (owner)
    assert.ok((stat.mode & 0o100) !== 0, "on-message.sh should be executable")

    let content = fs.readFileSync(hookPath, "utf8")
    assert.ok(content.includes("MSGMON_WORKSPACE"))
    assert.ok(content.includes("MSGMON_MSG_DIR"))
    assert.ok(content.startsWith("#!/usr/bin/env bash"))
  })

  it("workspace.json includes onMessage field", () => {
    let wsDir = path.join(tmpDir, "config-hook")
    initWorkspace(wsDir)

    let config = loadWorkspaceConfig(wsDir)
    assert.equal(config.onMessage, "./on-message.sh")
  })

  it("uses custom name, accounts, and query", () => {
    let wsDir = path.join(tmpDir, "custom")
    let result = initWorkspace(wsDir, {
      name: "work-inbox",
      accounts: ["work", "slack:team"],
      query: "newer_than:7d",
    })

    assert.equal(result.config.name, "work-inbox")
    assert.deepEqual(result.config.accounts, ["work", "slack:team"])
    assert.equal(result.config.query, "newer_than:7d")
  })

  it("rejects non-empty directories", () => {
    let wsDir = path.join(tmpDir, "existing")
    fs.mkdirSync(wsDir, { recursive: true })
    fs.writeFileSync(path.join(wsDir, "file.txt"), "data")

    assert.throws(
      () => initWorkspace(wsDir),
      /already exists and is not empty/,
    )
  })

  it("allows empty existing directories", () => {
    let wsDir = path.join(tmpDir, "empty-dir")
    fs.mkdirSync(wsDir, { recursive: true })

    let result = initWorkspace(wsDir)
    assert.equal(result.path, wsDir)
    assert.ok(fs.existsSync(path.join(wsDir, "workspace.json")))
  })

  it("workspace.json is valid JSON with expected fields", () => {
    let wsDir = path.join(tmpDir, "json-check")
    initWorkspace(wsDir)

    let raw = fs.readFileSync(path.join(wsDir, "workspace.json"), "utf8")
    let config = JSON.parse(raw)

    assert.equal(typeof config.name, "string")
    assert.ok(Array.isArray(config.accounts))
    assert.equal(typeof config.query, "string")
    assert.equal(typeof config.watchIntervalMs, "number")
    assert.equal(typeof config.onMessage, "string")
    assert.equal(typeof config.createdAt, "string")
  })

  it("instructions.md contains agent instructions", () => {
    let wsDir = path.join(tmpDir, "instructions-check")
    initWorkspace(wsDir)

    let content = fs.readFileSync(path.join(wsDir, "instructions.md"), "utf8")
    assert.ok(content.includes("Agent Instructions"))
    assert.ok(content.includes("brief me"))
  })

  it("status.md contains initial structure", () => {
    let wsDir = path.join(tmpDir, "status-check")
    initWorkspace(wsDir)

    let content = fs.readFileSync(path.join(wsDir, "status.md"), "utf8")
    assert.ok(content.includes("Urgent"))
    assert.ok(content.includes("Action Items"))
    assert.ok(content.includes("Draft Responses"))
  })
})

describe("loadWorkspaceConfig", () => {
  it("loads config from workspace directory", () => {
    let wsDir = path.join(tmpDir, "loadable")
    initWorkspace(wsDir, { name: "test-ws" })

    let config = loadWorkspaceConfig(wsDir)
    assert.equal(config.name, "test-ws")
  })

  it("throws for non-workspace directories", () => {
    assert.throws(
      () => loadWorkspaceConfig(tmpDir),
      /Not a workspace/,
    )
  })
})

describe("createChainSink", () => {
  it("calls all sinks in order", async () => {
    let order: string[] = []
    let sink1 = { async write() { order.push("first") } }
    let sink2 = { async write() { order.push("second") } }
    let chain = createChainSink([sink1, sink2])

    await chain.write(makeMsg("msg-1"))
    assert.deepEqual(order, ["first", "second"])
  })

  it("propagates errors from any sink", async () => {
    let ok = { async write() {} }
    let failing = { async write() { throw new Error("boom") } }
    let chain = createChainSink([ok, failing])

    await assert.rejects(() => chain.write(makeMsg("msg-1")), /boom/)
  })
})

describe("createWorkspaceHookSink", () => {
  it("runs hook script with MSGMON env vars", async () => {
    let wsDir = path.join(tmpDir, "hook-run")
    fs.mkdirSync(wsDir, { recursive: true })
    let inboxDir = path.join(wsDir, "inbox")
    fs.mkdirSync(inboxDir, { recursive: true })

    // Write a hook that dumps env to a file
    let envDump = path.join(wsDir, "env-dump.json")
    let hookPath = path.join(wsDir, "hook.sh")
    fs.writeFileSync(hookPath, `#!/usr/bin/env bash
cat <<HEREDOC > "${envDump}"
{
  "MSGMON_WORKSPACE": "$MSGMON_WORKSPACE",
  "MSGMON_ID": "$MSGMON_ID",
  "MSGMON_PLATFORM": "$MSGMON_PLATFORM",
  "MSGMON_SUBJECT": "$MSGMON_SUBJECT",
  "MSGMON_FROM": "$MSGMON_FROM"
}
HEREDOC
`)
    fs.chmodSync(hookPath, 0o755)

    let sink = createWorkspaceHookSink({
      command: hookPath,
      workspaceDir: wsDir,
      inboxDir,
    })

    await sink.write(makeMsg("test-123"))

    assert.ok(fs.existsSync(envDump), "hook should have created env dump file")
    let env = JSON.parse(fs.readFileSync(envDump, "utf8"))
    assert.equal(env.MSGMON_WORKSPACE, wsDir)
    assert.equal(env.MSGMON_ID, "test-123")
    assert.equal(env.MSGMON_PLATFORM, "gmail")
    assert.equal(env.MSGMON_SUBJECT, "Subject test-123")
    assert.equal(env.MSGMON_FROM, "sender@example.com")
  })

  it("rejects when hook exits non-zero", async () => {
    let wsDir = path.join(tmpDir, "hook-fail")
    fs.mkdirSync(wsDir, { recursive: true })
    let inboxDir = path.join(wsDir, "inbox")
    fs.mkdirSync(inboxDir, { recursive: true })

    let hookPath = path.join(wsDir, "fail.sh")
    fs.writeFileSync(hookPath, "#!/usr/bin/env bash\nexit 1\n")
    fs.chmodSync(hookPath, 0o755)

    let sink = createWorkspaceHookSink({
      command: hookPath,
      workspaceDir: wsDir,
      inboxDir,
    })

    await assert.rejects(
      () => sink.write(makeMsg("msg-1")),
      /on-message hook exited with code 1/,
    )
  })
})

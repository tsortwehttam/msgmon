import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initWorkspace, loadWorkspaceConfig } from "../src/workspace/init"

let tmpDir: string

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

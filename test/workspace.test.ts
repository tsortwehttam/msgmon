import { before, after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let tmpDir: string
let prevCwd: string
let workspaceStore: typeof import("../src/workspace/store")
let workspaceApi: typeof import("../src/workspace/api")
let draftStore: typeof import("../src/draft/store")
let workspaceAccounts: typeof import("../src/workspace/accounts")
let cliConfig: typeof import("../src/CliConfig")
let workspaceRuntime: typeof import("../src/workspace/runtime")

let makeDraft = (id: string) => ({
  id,
  platform: "gmail" as const,
  account: "default",
  to: "allowed@example.com",
  cc: [],
  bcc: [],
  subject: "Re: Test",
  body: "Draft body",
  attachments: [],
  createdAt: "2026-03-20T00:00:00.000Z",
  updatedAt: "2026-03-20T00:00:00.000Z",
})

before(async () => {
  prevCwd = process.cwd()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msgmon-workspace-test-"))
  fs.symlinkSync(path.join(prevCwd, "node_modules"), path.join(tmpDir, "node_modules"), "dir")
  process.chdir(tmpDir)
  cliConfig = await import("../src/CliConfig")
  workspaceStore = await import("../src/workspace/store")
  workspaceApi = await import("../src/workspace/api")
  draftStore = await import("../src/draft/store")
  workspaceAccounts = await import("../src/workspace/accounts")
  workspaceRuntime = await import("../src/workspace/runtime")
})

after(() => {
  process.chdir(prevCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("workspace store", () => {
  let useDir = (name: string) => {
    let dir = path.join(tmpDir, name)
    fs.mkdirSync(dir, { recursive: true })
    cliConfig.setWorkspaceDir(dir)
    return dir
  }

  it("creates a server workspace and exports only agent-safe files", () => {
    let dir = useDir("alpha")
    let result = workspaceStore.initWorkspace("alpha", {
      name: "Alpha Workspace",
      accounts: ["default", "slack:team"],
      query: "is:unread",
    })

    assert.equal(result.config.id, "alpha")
    assert.equal(result.config.pullWindowDays, 14)
    assert.equal(result.path, dir)
    assert.ok(fs.existsSync(path.join(result.path, "workspace.json")))
    assert.ok(fs.existsSync(path.join(result.path, "messages")))
    assert.ok(fs.existsSync(path.join(result.path, ".msgmon", "state")))

    fs.writeFileSync(path.join(result.path, ".msgmon", "secret.txt"), "do not export")
    fs.writeFileSync(path.join(result.path, "messages", "note.txt"), "history")

    let snapshot = workspaceStore.exportWorkspaceSnapshot("alpha")
    let paths = snapshot.files.map(file => file.path)
    assert.ok(paths.includes("workspace.json"))
    assert.ok(paths.includes("status.md"))
    assert.ok(paths.includes("messages/note.txt"))
    assert.ok(!paths.some(file => file.startsWith(".msgmon/")))
  })

  it("initializes gracefully inside an existing non-empty directory", () => {
    let dir = useDir("existing-dir")
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n")
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Existing\n")

    let result = workspaceStore.initWorkspace("default", {
      name: "Existing Dir Workspace",
      accounts: ["default"],
      query: "is:unread",
    })

    assert.equal(result.path, dir)
    assert.match(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), /keep me/)
    assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /# Existing/)
    assert.ok(fs.existsSync(path.join(dir, "workspace.json")))
    assert.ok(fs.existsSync(path.join(dir, "status.md")))
    assert.ok(fs.existsSync(path.join(dir, "messages")))
    assert.ok(fs.existsSync(path.join(dir, ".msgmon", "state")))
  })

  it("applies bounded pushes, validates drafts, and detects stale revisions", () => {
    useDir("beta")
    workspaceStore.initWorkspace("beta")
    let initial = workspaceStore.exportWorkspaceSnapshot("beta")
    let updatedStatus = Buffer.from("# Status\n\nUpdated\n", "utf8").toString("base64")
    let draftRecord = makeDraft("draft-1")
    let draftPath = `drafts/${draftStore.draftFileName(draftRecord)}`
    let draft = Buffer.from(JSON.stringify(draftRecord, null, 2) + "\n", "utf8").toString("base64")

    let pushed = workspaceStore.applyWorkspacePush("beta", {
      baseRevision: initial.revision,
      files: [
        { path: "status.md", contentBase64: updatedStatus },
        { path: draftPath, contentBase64: draft },
      ],
    })

    assert.notEqual(pushed.revision, initial.revision)
    assert.equal(draftStore.loadDraft("beta", "draft-1").id, "draft-1")

    assert.throws(
      () => workspaceStore.applyWorkspacePush("beta", {
        baseRevision: initial.revision,
        files: [{ path: "status.md", contentBase64: updatedStatus }],
      }),
      /revision conflict/,
    )

    assert.throws(
      () => workspaceStore.applyWorkspacePush("beta", {
        baseRevision: pushed.revision,
        files: [{ path: "workspace.json", contentBase64: updatedStatus }],
      }),
      /read-only/,
    )
  })

  it("exports and imports workspace bundles", () => {
    useDir("bundle-src")
    workspaceStore.initWorkspace("bundle-src", { name: "Bundle Source" })
    workspaceStore.applyWorkspacePush("bundle-src", {
      baseRevision: workspaceStore.exportWorkspaceSnapshot("bundle-src").revision,
      files: [{
        path: "status.md",
        contentBase64: Buffer.from("# Status\n\nBundled\n", "utf8").toString("base64"),
      }],
    })

    let bundle = workspaceStore.exportWorkspaceBundle("bundle-src")
    useDir("bundle-dst")
    let imported = workspaceStore.importWorkspaceBundle({
      workspaceId: "bundle-dst",
      bundleBase64: bundle.bundleBase64,
    })

    assert.equal(imported.workspaceId, "bundle-dst")
    assert.equal(workspaceStore.loadWorkspaceConfig("bundle-dst").name, "Bundle Source")
    let status = Buffer.from(imported.files.find(file => file.path === "status.md")!.contentBase64, "base64").toString("utf8")
    assert.match(status, /Bundled/)
  })

  it("tracks a pull state path and can infer the latest pulled message timestamp", () => {
    let dir = useDir("pull-state")
    let result = workspaceStore.initWorkspace("default", {
      accounts: ["default"],
      query: "in:inbox category:primary is:unread",
    })

    let pullStatePath = workspaceRuntime.buildWorkspacePullStatePath(
      result.config.id,
      result.config.accounts,
      result.config.query,
    )
    assert.match(pullStatePath, /pull-[a-f0-9]{16}\.json$/)

    fs.mkdirSync(path.join(dir, "messages"), { recursive: true })
    fs.writeFileSync(path.join(dir, "messages", "2026-03-22T00-00-00-000Z_gmail_a.json"), JSON.stringify({
      id: "a",
      platform: "gmail",
      timestamp: "2026-03-22T00:00:00.000Z",
      platformMetadata: { platform: "gmail", messageId: "a" },
    }) + "\n")
    fs.writeFileSync(path.join(dir, "messages", "2026-03-22T00-05-00-000Z_gmail_b.json"), JSON.stringify({
      id: "b",
      platform: "gmail",
      timestamp: "2026-03-22T00:05:00.000Z",
      platformMetadata: { platform: "gmail", messageId: "b" },
    }) + "\n")

    assert.equal(
      workspaceRuntime.latestPulledMessageTimestamp("default"),
      "2026-03-22T00:05:00.000Z",
    )
  })
})

describe("workspace API handlers", () => {
  it("supports export, push, and actions against the server-owned model", async () => {
    cliConfig.setWorkspaceDir(path.join(tmpDir, "gamma"))
    fs.mkdirSync(path.join(tmpDir, "gamma"), { recursive: true })
    workspaceStore.initWorkspace("gamma")
    let handlers = workspaceApi.createWorkspaceHandlers({
      gmailAllowTo: ["allowed@example.com"],
      slackAllowChannels: [],
      sendRateLimit: 0,
    })

    let exported = await handlers["POST /api/workspace/export"]({ workspaceId: "gamma" })
    assert.equal(exported.status, 200)
    let revision = (exported.data as { revision: string }).revision

    let push = await handlers["POST /api/workspace/push"]({
      workspaceId: "gamma",
      baseRevision: revision,
      files: [{
        path: `drafts/${draftStore.draftFileName(makeDraft("draft-2"))}`,
        contentBase64: Buffer.from(JSON.stringify(makeDraft("draft-2"), null, 2) + "\n", "utf8").toString("base64"),
      }],
    })
    assert.equal(push.status, 200)
    assert.equal(draftStore.loadDraft("gamma", "draft-2").id, "draft-2")

    let action = await handlers["POST /api/workspace/actions"]({
      workspaceId: "gamma",
      actions: [{ type: "draft.delete", draftId: "draft-2" }],
    })
    assert.equal(action.status, 200)
    assert.throws(() => draftStore.loadDraft("gamma", "draft-2"), /not found/)
  })
})

describe("workspace init account inference", () => {
  it("infers local gmail and slack accounts when --account is omitted", async () => {
    let dir = path.join(tmpDir, "accounts-a")
    fs.mkdirSync(path.join(dir, ".msgmon", "gmail", "tokens"), { recursive: true })
    fs.mkdirSync(path.join(dir, ".msgmon", "slack", "tokens"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".msgmon", "gmail", "tokens", "alpha.json"), "{}\n")
    fs.writeFileSync(path.join(dir, ".msgmon", "gmail", "tokens", "beta.json"), "{}\n")
    fs.writeFileSync(path.join(dir, ".msgmon", "slack", "tokens", "drinksuperoot.json"), "{}\n")
    cliConfig.setWorkspaceDir(dir)

    assert.deepEqual(
      workspaceAccounts.inferWorkspaceAccounts(),
      ["alpha", "beta", "slack:drinksuperoot"],
    )
  })

  it("errors when no accounts are provided and no local tokens exist", async () => {
    let dir = path.join(tmpDir, "accounts-b")
    fs.mkdirSync(dir, { recursive: true })
    cliConfig.setWorkspaceDir(dir)
    assert.deepEqual(workspaceAccounts.inferWorkspaceAccounts(), [])
  })

  it("returns only local token-backed accounts", async () => {
    let dir = path.join(tmpDir, "accounts-c")
    fs.mkdirSync(path.join(dir, ".msgmon", "gmail", "tokens"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".msgmon", "gmail", "tokens", "manual.json"), "{}\n")
    cliConfig.setWorkspaceDir(dir)
    assert.deepEqual(workspaceAccounts.inferWorkspaceAccounts(), ["manual"])
  })
})

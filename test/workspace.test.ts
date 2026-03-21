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
  workspaceStore = await import("../src/workspace/store")
  workspaceApi = await import("../src/workspace/api")
  draftStore = await import("../src/draft/store")
  workspaceAccounts = await import("../src/workspace/accounts")
})

after(() => {
  process.chdir(prevCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("workspace store", () => {
  it("creates a server-managed workspace and exports only agent-safe files", () => {
    let result = workspaceStore.initWorkspace("alpha", {
      name: "Alpha Workspace",
      accounts: ["default", "slack:team"],
      query: "is:unread",
    })

    assert.equal(result.config.id, "alpha")
    assert.equal(result.config.contextWindowDays, 14)
    assert.equal(result.config.contextMaxResults, 200)
    assert.ok(fs.existsSync(path.join(result.path, "workspace.json")))
    assert.ok(fs.existsSync(path.join(result.path, "inbox")))
    assert.ok(fs.existsSync(path.join(result.path, "context")))
    assert.ok(fs.existsSync(path.join(result.path, ".server", "state")))

    fs.writeFileSync(path.join(result.path, ".server", "secret.txt"), "do not export")
    fs.writeFileSync(path.join(result.path, "context", "note.txt"), "history")

    let snapshot = workspaceStore.exportWorkspaceSnapshot("alpha")
    let paths = snapshot.files.map(file => file.path)
    assert.ok(paths.includes("workspace.json"))
    assert.ok(paths.includes("status.md"))
    assert.ok(paths.includes("context/note.txt"))
    assert.ok(!paths.some(file => file.startsWith(".server/")))
  })

  it("applies bounded pushes, validates drafts, and detects stale revisions", () => {
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
    workspaceStore.initWorkspace("bundle-src", { name: "Bundle Source" })
    workspaceStore.applyWorkspacePush("bundle-src", {
      baseRevision: workspaceStore.exportWorkspaceSnapshot("bundle-src").revision,
      files: [{
        path: "status.md",
        contentBase64: Buffer.from("# Status\n\nBundled\n", "utf8").toString("base64"),
      }],
    })

    let bundle = workspaceStore.exportWorkspaceBundle("bundle-src")
    let imported = workspaceStore.importWorkspaceBundle({
      workspaceId: "bundle-dst",
      bundleBase64: bundle.bundleBase64,
    })

    assert.equal(imported.workspaceId, "bundle-dst")
    assert.equal(workspaceStore.loadWorkspaceConfig("bundle-dst").name, "Bundle Source")
    let status = Buffer.from(imported.files.find(file => file.path === "status.md")!.contentBase64, "base64").toString("utf8")
    assert.match(status, /Bundled/)
  })
})

describe("workspace API handlers", () => {
  it("supports export, push, and actions against the server-owned model", async () => {
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
    fs.mkdirSync(path.join(tmpDir, ".msgmon", "gmail", "tokens"), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, ".msgmon", "slack", "tokens"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, ".msgmon", "gmail", "tokens", "alpha.json"), "{}\n")
    fs.writeFileSync(path.join(tmpDir, ".msgmon", "gmail", "tokens", "beta.json"), "{}\n")
    fs.writeFileSync(path.join(tmpDir, ".msgmon", "slack", "tokens", "drinksuperoot.json"), "{}\n")

    assert.deepEqual(
      workspaceAccounts.inferWorkspaceAccounts(),
      ["alpha", "beta", "slack:drinksuperoot"],
    )
  })

  it("errors when no accounts are provided and no local tokens exist", async () => {
    fs.rmSync(path.join(tmpDir, ".msgmon", "gmail"), { recursive: true, force: true })
    fs.rmSync(path.join(tmpDir, ".msgmon", "slack"), { recursive: true, force: true })
    assert.deepEqual(workspaceAccounts.inferWorkspaceAccounts(), [])
  })

  it("returns only local token-backed accounts", async () => {
    fs.mkdirSync(path.join(tmpDir, ".msgmon", "gmail", "tokens"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, ".msgmon", "gmail", "tokens", "manual.json"), "{}\n")
    assert.deepEqual(workspaceAccounts.inferWorkspaceAccounts(), ["manual"])
  })
})

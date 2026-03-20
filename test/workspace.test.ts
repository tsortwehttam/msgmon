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
    assert.ok(fs.existsSync(path.join(result.path, "workspace.json")))
    assert.ok(fs.existsSync(path.join(result.path, "inbox")))
    assert.ok(fs.existsSync(path.join(result.path, ".server", "state")))

    fs.writeFileSync(path.join(result.path, ".server", "secret.txt"), "do not export")

    let snapshot = workspaceStore.exportWorkspaceSnapshot("alpha")
    let paths = snapshot.files.map(file => file.path)
    assert.ok(paths.includes("workspace.json"))
    assert.ok(paths.includes("status.md"))
    assert.ok(!paths.some(file => file.startsWith(".server/")))
  })

  it("applies bounded pushes, validates drafts, and detects stale revisions", () => {
    workspaceStore.initWorkspace("beta")
    let initial = workspaceStore.exportWorkspaceSnapshot("beta")
    let updatedStatus = Buffer.from("# Status\n\nUpdated\n", "utf8").toString("base64")
    let draft = Buffer.from(JSON.stringify(makeDraft("draft-1"), null, 2) + "\n", "utf8").toString("base64")

    let pushed = workspaceStore.applyWorkspacePush("beta", {
      baseRevision: initial.revision,
      files: [
        { path: "status.md", contentBase64: updatedStatus },
        { path: "drafts/draft-1.json", contentBase64: draft },
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
        path: "drafts/draft-2.json",
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

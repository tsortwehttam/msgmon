import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let tmpDir: string
let prevCwd: string
let serverModule: typeof import("../src/serve/server")

let requestJson = async (params: {
  port: number
  route: string
  method?: string
  token: string
  body?: unknown
}) => {
  let rawBody = params.body == null ? "" : JSON.stringify(params.body)
  return new Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: string } }>((resolve, reject) => {
    let req = http.request({
      host: "127.0.0.1",
      port: params.port,
      path: params.route,
      method: params.method ?? "POST",
      headers: {
        "X-Auth-Token": params.token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(rawBody),
      },
    }, res => {
      let chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(Buffer.from(chunk)))
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        })
      })
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end(rawBody)
  })
}

before(async () => {
  prevCwd = process.cwd()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msgmon-serve-integration-"))
  fs.symlinkSync(path.join(prevCwd, "node_modules"), path.join(tmpDir, "node_modules"), "dir")
  process.chdir(tmpDir)
  serverModule = await import("../src/serve/server")
})

after(() => {
  process.chdir(prevCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("serve integration", () => {
  it("enforces per-token capabilities and supports workspace bundle export/import over HTTP", async () => {
    let server = serverModule.createServer({
      host: "127.0.0.1",
      port: 0,
      tokens: [
        { token: "reader", capabilities: ["read", "workspace_read"] },
        { token: "writer", capabilities: ["workspace_write", "drafts"] },
        { token: "actor", capabilities: ["workspace_actions"] },
      ],
      verbose: false,
      gmailAllowTo: ["allowed@example.com"],
      slackAllowChannels: [],
      sendRateLimit: 0,
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    try {
      let address = server.address()
      assert.ok(address && typeof address === "object")
      let port = address.port

      let bootstrap = await requestJson({
        port,
        route: "/api/workspace/bootstrap",
        token: "writer",
        body: { workspaceId: "http-ws", name: "HTTP Workspace", accounts: ["default"], query: "is:unread" },
      })
      assert.equal(bootstrap.status, 200)

      let forbiddenExport = await requestJson({
        port,
        route: "/api/workspace/export",
        token: "writer",
        body: { workspaceId: "http-ws" },
      })
      assert.equal(forbiddenExport.status, 403)

      let compose = await requestJson({
        port,
        route: "/api/draft/compose",
        token: "writer",
        body: {
          workspaceId: "http-ws",
          platform: "gmail",
          account: "default",
          to: "allowed@example.com",
          subject: "Test",
          body: "Hello",
        },
      })
      assert.equal(compose.status, 200)
      let draftId = ((compose.body.data as { id: string }).id)

      let exported = await requestJson({
        port,
        route: "/api/workspace/export",
        token: "reader",
        body: { workspaceId: "http-ws", format: "bundle" },
      })
      assert.equal(exported.status, 200)
      let bundleBase64 = (exported.body.data as { bundleBase64: string }).bundleBase64
      assert.ok(bundleBase64.length > 0)

      let imported = await requestJson({
        port,
        route: "/api/workspace/import",
        token: "writer",
        body: { workspaceId: "http-copy", bundleBase64 },
      })
      assert.equal(imported.status, 200)

      let list = await requestJson({
        port,
        route: "/api/draft/list",
        token: "writer",
        body: { workspaceId: "http-copy" },
      })
      assert.equal(list.status, 200)
      let drafts = (list.body.data as { drafts: Array<{ id: string }> }).drafts
      assert.equal(drafts.length, 1)
      assert.equal(drafts[0].id, draftId)

      let deleteAction = await requestJson({
        port,
        route: "/api/workspace/actions",
        token: "actor",
        body: {
          workspaceId: "http-copy",
          actions: [{ type: "draft.delete", draftId }],
        },
      })
      assert.equal(deleteAction.status, 200)

      let health = await requestJson({
        port,
        route: "/api/health",
        method: "GET",
        token: "reader",
      })
      assert.equal(health.status, 200)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    }
  })
})

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import type { UnifiedMessage } from "../types"
import type { Sink } from "../ingest/sinks"

/**
 * Creates a sink that runs a hook command after the dir sink writes.
 * Adds MSGMON_WORKSPACE and MSGMON_MSG_DIR to the exec environment.
 */
export let createWorkspaceHookSink = (params: {
  command: string
  workspaceDir: string
  inboxDir: string
}): Sink => ({
  async write(msg) {
    // Compute the message directory path (mirrors dir sink naming)
    let safeSubject = msg.subject?.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 200) || "no_subject"
    let stamp = msg.timestamp.replace(/[:.]/g, "-")
    let dirName = `${stamp}_${msg.id}_${safeSubject}`
    let msgDir = path.resolve(params.inboxDir, dirName)

    let env: Record<string, string> = {
      MSGMON_WORKSPACE: params.workspaceDir,
      MSGMON_MSG_DIR: msgDir,
      MSGMON_ID: msg.id,
      MSGMON_PLATFORM: msg.platform,
      MSGMON_TIMESTAMP: msg.timestamp,
      MSGMON_SUBJECT: msg.subject ?? "",
      MSGMON_FROM: msg.from?.address ?? "",
      MSGMON_THREAD_ID: msg.threadId ?? "",
      MSGMON_JSON: JSON.stringify(msg),
    }

    await new Promise<void>((resolve, reject) => {
      let child = spawn(params.command, {
        cwd: params.workspaceDir,
        env: { ...process.env, ...env },
        shell: true,
        stdio: "inherit",
      })
      child.on("error", reject)
      child.on("exit", code => {
        if (code === 0) return resolve()
        reject(new Error(`on-message hook exited with code ${code ?? "unknown"}`))
      })
    })
  },
})

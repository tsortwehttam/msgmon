import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"
import { z } from "zod"
import { PWD_CONFIG_DIR, LOCAL_CONFIG_DIRNAME, currentWorkspaceDir } from "../CliConfig"
import { DEFAULT_GMAIL_WORKSPACE_QUERY, DEFAULT_WORKSPACE_ID } from "../defaults"
import { Draft } from "../draft/schema"

export interface WorkspaceConfig {
  id: string
  name: string
  accounts: string[]
  query: string
  slackChannels?: Record<string, string[]>
  createdAt: string
  updatedAt: string
}

export type WorkspaceExportFile = {
  path: string
  contentBase64: string
  mode: number
}

export type WorkspacePushFile = {
  path: string
  contentBase64?: string
  deleted?: boolean
}

export type WorkspaceBundle = {
  format: "msgmon.workspace.bundle.v1"
  workspaceId: string
  revision: string
  config: WorkspaceConfig
  files: WorkspaceExportFile[]
}

let WORKSPACE_DIRS = ["drafts"] as const
let SERVER_DIRNAME = ".server"

let DEFAULT_AGENTS = `# AGENTS.md

You are managing a message workspace for a human user.

Your job is to help the user stay on top of communications and the work that
flows from them. Use the message history in this workspace to understand what
is happening, identify what matters, and produce useful outputs for the user.

## What You Should Do

- Read \`messages.jsonl\` for the pulled message history.
- The first thing you should do is tell the user the new important information they need to know now, especially urgent issues, deadlines, risks, notable updates, or anything that changes priorities.
- After that, tell the user the next actions you recommend taking.
- Then ask the user whether you should proceed.
- Treat \`status.md\` as the authoritative working summary of the workspace.
- Update \`status.md\` before and after any substantial work so it accurately reflects the current state.
- Keep \`status.md\` current with outstanding tasks, deadlines, blockers, urgent issues, and follow-ups.
- Surface urgent problems, critical mistakes, missed commitments, and time-sensitive decisions.
- Track open loops across multiple threads and people.
- Proactively draft replies when helpful.
- Help coordinate complex work across multiple people and conversations.
- Summarize documents, attachments, and message threads.
- Produce artifacts the user may need, such as reports, plans, documents, presentations, summaries, and research notes.
- Research issues raised in messages and suggest next steps.
- Help the user schedule future work and sequence follow-ups.
- When running in a synced session, use the local \`.msgmon-session/\` metadata to discover the messaging proxy server and its available API capabilities.

## Workspace Layout

\`\`\`
workspace.json  — read-only workspace metadata
AGENTS.md       — this file
status.md       — working summary maintained by the agent
messages.jsonl  — pulled message history as JSONL (read-only)
drafts/         — draft JSON files the agent may create or revise
\`\`\`

## Rules

- Treat \`workspace.json\` and \`messages.jsonl\` as read-only.
- \`status.md\` must be kept accurate. Do not leave it stale after reviewing messages, creating drafts, researching issues, or changing plans.
- Never send a message without explicit user approval.
- Do not assume local tools can safely mutate remote state.
- Use the messaging proxy server API for privileged actions such as send, mark-read, archive, and other server-backed actions.
- Prefer revising an existing draft over creating duplicate drafts.
- Keep \`status.md\` concise, high-signal, and decision-useful.
- If a \`README.md\` or \`instructions.md\` file is present in the workspace, read and follow those instructions as well.
`

let DEFAULT_STATUS = `# Status

> Last updated: never

## Urgent

_Nothing urgent._

## Action Items

_No pending action items._

## Draft Responses

_No drafts pending review._

## Summary

_No messages processed yet._
`

let WorkspaceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accounts: z.array(z.string()).min(1),
  query: z.string(),
  slackChannels: z.record(z.array(z.string())).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

let relativePath = (...parts: string[]) => path.resolve(currentWorkspaceDir(), ...parts)

export let workspaceRoot = (_workspaceId = DEFAULT_WORKSPACE_ID) => relativePath()
export let workspaceServerRoot = (_workspaceId = DEFAULT_WORKSPACE_ID) => path.resolve(PWD_CONFIG_DIR)
export let workspaceStateRoot = (_workspaceId = DEFAULT_WORKSPACE_ID) => path.resolve(PWD_CONFIG_DIR, "state")
export let workspaceDraftsRoot = (_workspaceId = DEFAULT_WORKSPACE_ID) => relativePath("drafts")

let ensureSafeWorkspaceId = (workspaceId: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error(`Invalid workspace id "${workspaceId}"`)
  }
  return workspaceId
}

let normalizeWorkspacePath = (workspaceId: string, relPath: string) => {
  let normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  let resolved = path.resolve(workspaceRoot(workspaceId), normalized)
  let relative = path.relative(workspaceRoot(workspaceId), resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid workspace path "${relPath}"`)
  }
  return { normalized: relative.replace(/\\/g, "/"), resolved }
}

let isExportablePath = (relPath: string) => {
  let first = relPath.split("/")[0] ?? ""
  return !first.startsWith(".")
}

let isWritablePath = (relPath: string) =>
  relPath === "status.md"
  || relPath === "AGENTS.md"
  || relPath.startsWith("drafts/")

let MANAGED_FILE_PATHS = ["workspace.json", "AGENTS.md", "status.md", "messages.jsonl"] as const
let MANAGED_DIR_PATHS = [...WORKSPACE_DIRS, LOCAL_CONFIG_DIRNAME] as const

let ensureWorkspaceLayoutCompatible = (root: string) => {
  for (let dir of MANAGED_DIR_PATHS) {
    let target = path.resolve(root, dir)
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
      throw new Error(`Cannot initialize workspace: "${target}" exists and is not a directory`)
    }
  }

  for (let file of MANAGED_FILE_PATHS) {
    let target = path.resolve(root, file)
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      throw new Error(`Cannot initialize workspace: "${target}" exists and is not a file`)
    }
  }
}

let validateWorkspaceDraftFile = (relPath: string, content: string) => {
  if (!relPath.startsWith("drafts/") || !relPath.endsWith(".json")) return
  let draft = Draft.parse(JSON.parse(content))
  if (!relPath.endsWith(`_${draft.id}.json`)) {
    throw new Error(`Draft file path must end with _${draft.id}.json`)
  }
}

let readFilesRecursive = (root: string, dir = root): WorkspaceExportFile[] => {
  let entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  let files: WorkspaceExportFile[] = []
  for (let entry of entries) {
    let abs = path.resolve(dir, entry.name)
    let rel = path.relative(root, abs).replace(/\\/g, "/")
    if (!isExportablePath(rel)) continue
    if (entry.isDirectory()) {
      files.push(...readFilesRecursive(root, abs))
      continue
    }
    if (!entry.isFile()) continue
    let stat = fs.statSync(abs)
    files.push({
      path: rel,
      contentBase64: fs.readFileSync(abs).toString("base64"),
      mode: stat.mode & 0o777,
    })
  }
  return files
}

let removePathIfExists = (target: string) => {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}

let computeRevision = (files: WorkspaceExportFile[]) => {
  let hash = crypto.createHash("sha256")
  for (let file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(String(file.mode))
    hash.update("\0")
    hash.update(file.contentBase64)
    hash.update("\0")
  }
  return hash.digest("hex")
}

export let initWorkspace = (
  workspaceId = DEFAULT_WORKSPACE_ID,
  options: {
    name?: string
    accounts?: string[]
    query?: string
    slackChannels?: Record<string, string[]>
    overwrite?: boolean
  } = {},
) => {
  let id = ensureSafeWorkspaceId(workspaceId)
  let root = workspaceRoot(id)

  if (fs.existsSync(root)) {
    ensureWorkspaceLayoutCompatible(root)
    if (options.overwrite) {
      for (let relPath of [...MANAGED_FILE_PATHS, ...MANAGED_DIR_PATHS]) {
        removePathIfExists(path.resolve(root, relPath))
      }
    }
  }

  fs.mkdirSync(root, { recursive: true })
  for (let dir of WORKSPACE_DIRS) {
    fs.mkdirSync(path.resolve(root, dir), { recursive: true })
  }
  fs.mkdirSync(workspaceStateRoot(id), { recursive: true })
  if (!fs.existsSync(path.resolve(root, "messages.jsonl"))) {
    fs.writeFileSync(path.resolve(root, "messages.jsonl"), "")
  }

  let now = new Date().toISOString()
  let config: WorkspaceConfig = {
    id,
    name: options.name ?? id,
    accounts: options.accounts ?? ["default"],
    query: options.query ?? DEFAULT_GMAIL_WORKSPACE_QUERY,
    slackChannels: options.slackChannels && Object.keys(options.slackChannels).length ? options.slackChannels : undefined,
    createdAt: now,
    updatedAt: now,
  }

  fs.writeFileSync(path.resolve(root, "workspace.json"), JSON.stringify(config, null, 2) + "\n")
  if (!fs.existsSync(path.resolve(root, "AGENTS.md"))) {
    fs.writeFileSync(path.resolve(root, "AGENTS.md"), DEFAULT_AGENTS)
  }
  if (!fs.existsSync(path.resolve(root, "status.md"))) {
    fs.writeFileSync(path.resolve(root, "status.md"), DEFAULT_STATUS)
  }

  return { path: root, config }
}

export let listWorkspaceIds = () => {
  let configPath = path.resolve(workspaceRoot(DEFAULT_WORKSPACE_ID), "workspace.json")
  if (!fs.existsSync(configPath)) return []
  return [loadWorkspaceConfig(DEFAULT_WORKSPACE_ID).id]
}

export let loadWorkspaceConfig = (workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceConfig => {
  let id = ensureSafeWorkspaceId(workspaceId)
  let configPath = path.resolve(workspaceRoot(id), "workspace.json")
  if (!fs.existsSync(configPath)) {
    throw new Error(`Workspace not found in "${workspaceRoot(id)}"`)
  }
  return WorkspaceConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")))
}

export let saveWorkspaceConfig = (config: WorkspaceConfig) => {
  let next = { ...config, updatedAt: new Date().toISOString() }
  fs.writeFileSync(path.resolve(workspaceRoot(config.id), "workspace.json"), JSON.stringify(next, null, 2) + "\n")
  return next
}

export let exportWorkspaceSnapshot = (workspaceId: string) => {
  let config = loadWorkspaceConfig(workspaceId)
  let root = workspaceRoot(config.id)
  let files = readFilesRecursive(root).sort((a, b) => a.path.localeCompare(b.path))
  return {
    workspaceId: config.id,
    revision: computeRevision(files),
    config,
    files,
  }
}

export let exportWorkspaceBundle = (workspaceId: string) => {
  let snapshot = exportWorkspaceSnapshot(workspaceId)
  let bundle: WorkspaceBundle = {
    format: "msgmon.workspace.bundle.v1",
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    config: snapshot.config,
    files: snapshot.files,
  }
  let json = JSON.stringify(bundle)
  let gzip = zlib.gzipSync(Buffer.from(json, "utf8"))
  return {
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    encoding: "base64" as const,
    compression: "gzip" as const,
    mediaType: "application/vnd.msgmon.workspace-bundle+json",
    bundleBase64: gzip.toString("base64"),
  }
}

let writeSnapshotFiles = (workspaceId: string, files: WorkspaceExportFile[]) => {
  for (let file of files) {
    let target = normalizeWorkspacePath(workspaceId, file.path)
    if (!isExportablePath(target.normalized)) continue
    fs.mkdirSync(path.dirname(target.resolved), { recursive: true })
    fs.writeFileSync(target.resolved, Buffer.from(file.contentBase64, "base64"))
    fs.chmodSync(target.resolved, file.mode)
  }
}

export let importWorkspaceBundle = (params: {
  workspaceId?: string
  bundleBase64: string
  overwrite?: boolean
}) => {
  let raw = zlib.gunzipSync(Buffer.from(params.bundleBase64, "base64")).toString("utf8")
  let bundle = JSON.parse(raw) as WorkspaceBundle
  if (bundle.format !== "msgmon.workspace.bundle.v1") {
    throw new Error(`Unsupported workspace bundle format "${(bundle as { format?: string }).format ?? "unknown"}"`)
  }

  let workspaceId = ensureSafeWorkspaceId(params.workspaceId ?? bundle.workspaceId ?? DEFAULT_WORKSPACE_ID)
  let root = workspaceRoot(workspaceId)
  if (fs.existsSync(root)) {
    ensureWorkspaceLayoutCompatible(root)
  }

  initWorkspace(workspaceId, {
    name: bundle.config.name,
    accounts: bundle.config.accounts,
    query: bundle.config.query,
    overwrite: params.overwrite,
  })
  writeSnapshotFiles(workspaceId, bundle.files)
  let config = saveWorkspaceConfig({
    ...bundle.config,
    id: workspaceId,
    createdAt: bundle.config.createdAt,
    updatedAt: bundle.config.updatedAt,
  })
  return {
    ...exportWorkspaceSnapshot(workspaceId),
    config,
  }
}

export let applyWorkspacePush = (
  workspaceId: string,
  params: { baseRevision: string; files: WorkspacePushFile[] },
) => {
  let current = exportWorkspaceSnapshot(workspaceId)
  if (current.revision !== params.baseRevision) {
    throw new Error(`Workspace revision conflict: expected ${params.baseRevision}, current is ${current.revision}`)
  }

  for (let patch of params.files) {
    let target = normalizeWorkspacePath(workspaceId, patch.path)
    if (!isWritablePath(target.normalized)) {
      throw new Error(`Path "${target.normalized}" is read-only`)
    }

    if (patch.deleted) {
      if (fs.existsSync(target.resolved)) fs.rmSync(target.resolved, { recursive: true, force: true })
      continue
    }

    if (patch.contentBase64 == null) {
      throw new Error(`Missing contentBase64 for "${target.normalized}"`)
    }

    let content = Buffer.from(patch.contentBase64, "base64")
    if (target.normalized.startsWith("drafts/")) {
      validateWorkspaceDraftFile(target.normalized, content.toString("utf8"))
    }

    fs.mkdirSync(path.dirname(target.resolved), { recursive: true })
    fs.writeFileSync(target.resolved, content)
  }

  let nextConfig = saveWorkspaceConfig(loadWorkspaceConfig(workspaceId))
  return {
    ...exportWorkspaceSnapshot(workspaceId),
    config: nextConfig,
  }
}

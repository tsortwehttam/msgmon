import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { currentWorkspaceDir } from "../CliConfig"
import { DEFAULT_WORKSPACE_ID } from "../defaults"
import { DEFAULT_SERVER_URL, loadServeLocalConfig } from "../serve/localConfig"

export type WorkspaceExportFile = {
  path: string
  contentBase64: string
  mode: number
}

export type WorkspaceSnapshot = {
  workspaceId: string
  revision: string
  config: {
    id: string
    name: string
    accounts: string[]
    query: string
    createdAt: string
    updatedAt: string
  }
  files: WorkspaceExportFile[]
}

export type AgentManifest = {
  name: string
  version: string
  protocolVersion: string
  recommendedPollingIntervalMs: number
  auth: {
    header: string
    tokenCapabilities: string[]
  }
}

type WorkspacePushFile =
  | { path: string; contentBase64: string }
  | { path: string; deleted: true }

type SessionState = {
  serverUrl: string
  workspaceId: string
  token: string
  lastRevision: string
  lastSnapshot: WorkspaceSnapshot
  manifest: AgentManifest
  syncedAt: string
}

let SESSION_DIRNAME = ".msgmon-session"
let SESSION_STATE_PATH = "session.json"
let SESSION_PID_PATH = "watch.pid"

let normalizeServerUrl = (serverUrl: string) => serverUrl.replace(/\/+$/, "")

export let defaultSessionDir = () => currentWorkspaceDir()

export let resolveSessionConnection = (params: { serverUrl?: string; token?: string }) => {
  let localConfig = loadServeLocalConfig()
  let serverUrl = normalizeServerUrl(params.serverUrl ?? localConfig?.serverUrl ?? DEFAULT_SERVER_URL)
  let token = params.token ?? localConfig?.token
  if (!token) {
    throw new Error("No token provided and none found in ./.msgmon/serve.json")
  }
  return { serverUrl, token }
}

let sessionRoot = (dir: string) => path.resolve(dir, SESSION_DIRNAME)
let sessionStatePath = (dir: string) => path.resolve(sessionRoot(dir), SESSION_STATE_PATH)
let sessionPidPath = (dir: string) => path.resolve(sessionRoot(dir), SESSION_PID_PATH)

let writablePath = (relPath: string) =>
  relPath === "status.md"
  || relPath === "AGENTS.md"
  || relPath.startsWith("drafts/")

let exportablePath = (relPath: string) => !(relPath.split("/")[0] ?? "").startsWith(".")

let request = async <T>(params: {
  serverUrl: string
  token?: string
  route: string
  method?: "GET" | "POST"
  body?: unknown
  responseType?: "json" | "text"
}): Promise<T> => {
  let headers: Record<string, string> = {}
  if (params.token) headers["X-Auth-Token"] = params.token
  if (params.body != null) headers["Content-Type"] = "application/json"

  let response = await fetch(`${normalizeServerUrl(params.serverUrl)}${params.route}`, {
    method: params.method ?? "POST",
    headers,
    body: params.body == null ? undefined : JSON.stringify(params.body),
  })

  if (params.responseType === "text") {
    let text = await response.text()
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`)
    return text as T
  }

  let payload = await response.json() as { ok: boolean; data?: T; error?: string }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`)
  }
  return payload.data as T
}

let fileMap = (files: WorkspaceExportFile[]) =>
  new Map(files.map(file => [file.path, file]))

let ensureDir = (dir: string) => fs.mkdirSync(dir, { recursive: true })

let loadState = (dir: string): SessionState | undefined => {
  let filePath = sessionStatePath(dir)
  if (!fs.existsSync(filePath)) return undefined
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionState
}

let saveState = (dir: string, state: SessionState) => {
  ensureDir(sessionRoot(dir))
  fs.writeFileSync(sessionStatePath(dir), JSON.stringify(state, null, 2) + "\n")
}

let relativeSessionFiles = new Set([
  `${SESSION_DIRNAME}/${SESSION_STATE_PATH}`,
  `${SESSION_DIRNAME}/${SESSION_PID_PATH}`,
])

let listLocalFiles = (root: string, dir = root): string[] => {
  if (!fs.existsSync(root)) return []
  let entries = fs.readdirSync(dir, { withFileTypes: true })
  let files: string[] = []
  for (let entry of entries) {
    let abs = path.resolve(dir, entry.name)
    let rel = path.relative(root, abs).replace(/\\/g, "/")
    if (relativeSessionFiles.has(rel) || rel.startsWith(`${SESSION_DIRNAME}/`)) continue
    if (entry.isDirectory()) {
      files.push(...listLocalFiles(root, abs))
      continue
    }
    if (entry.isFile()) files.push(rel)
  }
  return files.sort()
}

let readLocalFileBase64 = (dir: string, relPath: string) =>
  fs.readFileSync(path.resolve(dir, relPath)).toString("base64")

let dirtyWritablePaths = (dir: string, state: SessionState) => {
  let previous = fileMap(state.lastSnapshot.files)
  let localPaths = new Set(listLocalFiles(dir).filter(writablePath))
  let previousPaths = new Set(state.lastSnapshot.files.map(file => file.path).filter(writablePath))
  let dirty = new Set<string>()

  for (let relPath of localPaths) {
    let previousFile = previous.get(relPath)
    let localContent = readLocalFileBase64(dir, relPath)
    if (!previousFile || previousFile.contentBase64 !== localContent) dirty.add(relPath)
  }

  for (let relPath of previousPaths) {
    if (!localPaths.has(relPath)) dirty.add(relPath)
  }

  return Array.from(dirty).sort()
}

let writeSnapshot = (dir: string, snapshot: WorkspaceSnapshot) => {
  ensureDir(dir)
  let incoming = fileMap(snapshot.files)
  let existing = listLocalFiles(dir)

  for (let relPath of existing) {
    if (!exportablePath(relPath)) continue
    if (!incoming.has(relPath)) {
      fs.rmSync(path.resolve(dir, relPath), { recursive: true, force: true })
    }
  }

  for (let file of snapshot.files) {
    let target = path.resolve(dir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(file.contentBase64, "base64"))
    fs.chmodSync(target, file.mode)
  }
}

let ensureInitializedDirectory = (dir: string, force = false) => {
  ensureDir(dir)
  let entries = fs.readdirSync(dir).filter(name => name !== SESSION_DIRNAME)
  if (entries.length > 0 && !loadState(dir) && !force) {
    throw new Error(`Refusing to initialize non-empty directory "${dir}". Use --force to overwrite.`)
  }
}

export let syncPull = async (params: {
  serverUrl?: string
  token?: string
  workspaceId?: string
  dir?: string
  force?: boolean
}) => {
  let workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID
  let dir = path.resolve(params.dir ?? defaultSessionDir())
  let connection = resolveSessionConnection({ serverUrl: params.serverUrl, token: params.token })
  ensureInitializedDirectory(dir, params.force)

  let manifest = await request<AgentManifest>({
    serverUrl: connection.serverUrl,
    token: connection.token,
    route: "/api/agent/manifest",
    method: "GET",
  })
  let snapshot = await request<WorkspaceSnapshot>({
    serverUrl: connection.serverUrl,
    token: connection.token,
    route: "/api/workspace/export",
    body: { workspaceId, format: "snapshot" },
  })

  let previous = loadState(dir)
  if (previous && !params.force) {
    let dirty = dirtyWritablePaths(dir, previous)
    if (dirty.length > 0) {
      throw new Error(`Local writable files have changed: ${dirty.join(", ")}. Push them first or re-run with --force.`)
    }
  }

  writeSnapshot(dir, snapshot)
  let state: SessionState = {
    serverUrl: connection.serverUrl,
    workspaceId,
    token: connection.token,
    lastRevision: snapshot.revision,
    lastSnapshot: snapshot,
    manifest,
    syncedAt: new Date().toISOString(),
  }
  saveState(dir, state)
  return {
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    fileCount: snapshot.files.length,
    path: dir,
    pollIntervalMs: manifest.recommendedPollingIntervalMs,
  }
}

export let syncPush = async (params: {
  dir?: string
  serverUrl?: string
  token?: string
  workspaceId?: string
}) => {
  let dir = path.resolve(params.dir ?? defaultSessionDir())
  let state = loadState(dir)
  if (!state) throw new Error(`No client state found in "${dir}". Run client pull first.`)

  let serverUrl = params.serverUrl ?? state.serverUrl
  let token = params.token ?? state.token
  let workspaceId = params.workspaceId ?? state.workspaceId
  let previous = fileMap(state.lastSnapshot.files)
  let localPaths = listLocalFiles(dir).filter(writablePath)
  let previousWritablePaths = state.lastSnapshot.files.map(file => file.path).filter(writablePath)

  let files: WorkspacePushFile[] = localPaths.map(relPath => ({
    path: relPath,
    contentBase64: readLocalFileBase64(dir, relPath),
  }))

  for (let relPath of previousWritablePaths) {
    if (!localPaths.includes(relPath)) files.push({ path: relPath, deleted: true })
  }

  let changed = files.filter(file => {
    if ("deleted" in file && file.deleted) return true
    if (!("contentBase64" in file)) return true
    let previousFile = previous.get(file.path)
    return !previousFile || previousFile.contentBase64 !== file.contentBase64
  })

  if (changed.length === 0) {
    return {
      workspaceId,
      revision: state.lastRevision,
      pushed: false,
      changedFiles: 0,
    }
  }

  let next = await request<WorkspaceSnapshot>({
    serverUrl,
    token,
    route: "/api/workspace/push",
    body: {
      workspaceId,
      baseRevision: state.lastRevision,
      files: changed,
    },
  })

  writeSnapshot(dir, next)
  saveState(dir, {
    ...state,
    serverUrl,
    token,
    workspaceId,
    lastRevision: next.revision,
    lastSnapshot: next,
    syncedAt: new Date().toISOString(),
  })

  return {
    workspaceId,
    revision: next.revision,
    pushed: true,
    changedFiles: changed.length,
  }
}

export let syncWatch = async (params: {
  serverUrl?: string
  token?: string
  workspaceId?: string
  dir?: string
  intervalMs: number
  force?: boolean
  autoPush?: boolean
  onTick?: (result: { ok: boolean; message: string }) => void
}) => {
  while (true) {
    if (params.autoPush !== false) {
      try {
        let pushResult = await syncPush({
          dir: params.dir,
          serverUrl: params.serverUrl,
          token: params.token,
          workspaceId: params.workspaceId,
        })
        if (pushResult.pushed) {
          params.onTick?.({ ok: true, message: `pushed ${pushResult.changedFiles} changed file(s) at revision ${pushResult.revision}` })
        }
      } catch (error) {
        params.onTick?.({ ok: false, message: `push skipped: ${(error as Error).message}` })
      }
    }
    try {
      let result = await syncPull(params)
      params.onTick?.({ ok: true, message: `synced revision ${result.revision}` })
    } catch (error) {
      params.onTick?.({ ok: false, message: (error as Error).message })
    }
    await new Promise(resolve => setTimeout(resolve, params.intervalMs))
  }
}

export let startSession = async (params: {
  serverUrl?: string
  token?: string
  workspaceId?: string
  dir?: string
  intervalMs?: number
  watch?: boolean
  autoPush?: boolean
  agentCommand?: string
  force?: boolean
}) => {
  let workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID
  let dir = path.resolve(params.dir ?? defaultSessionDir())
  let connection = resolveSessionConnection({ serverUrl: params.serverUrl, token: params.token })
  try {
    await request({
      serverUrl: connection.serverUrl,
      token: connection.token,
      route: "/api/workspace/pull",
      body: { workspaceId },
    })
  } catch {
    // Session start should still work for read-only tokens; best-effort reconcile only.
  }
  let pull = await syncPull({
    serverUrl: connection.serverUrl,
    token: connection.token,
    workspaceId,
    dir,
    force: params.force,
  })

  let watchPid: number | undefined
  if (params.watch) {
    let child = spawn(process.execPath, [
      process.argv[1]!,
      "client",
      "watch",
      `--server=${connection.serverUrl}`,
      `--token=${connection.token}`,
      `--dir=${dir}`,
      `--interval-ms=${params.intervalMs ?? pull.pollIntervalMs}`,
      ...(params.autoPush === false ? ["--no-auto-push"] : []),
    ], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    watchPid = child.pid
    ensureDir(sessionRoot(dir))
    fs.writeFileSync(sessionPidPath(dir), `${watchPid}\n`)
  }

  if (params.agentCommand) {
    spawn(params.agentCommand, {
      cwd: dir,
      stdio: "inherit",
      shell: true,
    })
  }

  return {
    ...pull,
    watchPid,
    agentCommand: params.agentCommand ?? null,
  }
}

export let stopSessionWatch = (dir: string) => {
  let pidPath = sessionPidPath(path.resolve(dir))
  if (!fs.existsSync(pidPath)) throw new Error(`No watch pid found in "${pidPath}"`)
  let pid = Number(fs.readFileSync(pidPath, "utf8").trim())
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`Invalid watch pid "${pid}"`)
  process.kill(pid)
  fs.rmSync(pidPath, { force: true })
  return { stopped: true, pid }
}

export let loadSessionState = (dir: string) => {
  let state = loadState(path.resolve(dir))
  if (!state) throw new Error(`No client state found in "${dir}"`)
  return state
}

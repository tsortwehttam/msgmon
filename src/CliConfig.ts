import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Platform } from "./types"

export let DEFAULT_ACCOUNT = "default"

export let APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export let LOCAL_CONFIG_DIRNAME = ".msgmon"
export let PWD_CONFIG_DIR = path.resolve(process.cwd(), LOCAL_CONFIG_DIRNAME)
export let APP_CONFIG_DIR = path.resolve(APP_DIR, LOCAL_CONFIG_DIRNAME)
export let GLOBAL_CONFIG_DIR = path.resolve(os.homedir(), ".msgmon")
export let TOKEN_FILE_EXTENSION = ".json"

export let setPwdConfigDir = (dir: string) => {
  PWD_CONFIG_DIR = path.resolve(dir)
}

export let setWorkspaceDir = (dir: string) => {
  PWD_CONFIG_DIR = path.resolve(dir, LOCAL_CONFIG_DIRNAME)
}

export let currentWorkspaceDir = () => path.dirname(PWD_CONFIG_DIR)

// ---------------------------------------------------------------------------
// Config directory resolution (prepended → pwd → app-install → home)
// ---------------------------------------------------------------------------

let dedupe = (paths: string[]) => Array.from(new Set(paths.map(x => path.resolve(x))))

let prependedConfigDirs: string[] = []

/**
 * Prepend a config directory to the resolution chain.
 * Used by server workspaces to inject a workspace-local .msgmon/ dir
 * so tokens/credentials there are found before the cwd fallback.
 */
export let prependConfigDir = (dir: string) => {
  prependedConfigDirs.unshift(path.resolve(dir))
}

/** Remove a previously prepended config directory. */
export let removePrependedConfigDir = (dir: string) => {
  let resolved = path.resolve(dir)
  prependedConfigDirs = prependedConfigDirs.filter(d => d !== resolved)
}

/** Returns the config directories in resolution order */
export let resolveConfigDirs = () => dedupe([...prependedConfigDirs, PWD_CONFIG_DIR, APP_CONFIG_DIR, GLOBAL_CONFIG_DIR])

/** Platform-specific credentials file (e.g. .msgmon/gmail/credentials.json) */
let platformCredentialsPaths = (platform: Platform) =>
  resolveConfigDirs().map(dir => path.resolve(dir, platform, "credentials.json"))

/** Platform-specific token directory (e.g. .msgmon/gmail/tokens/) */
let platformTokenDirs = (platform: Platform) =>
  resolveConfigDirs().map(dir => path.resolve(dir, platform, "tokens"))

export let GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
]

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

export let resolveCredentialsPaths = (platform: Platform) => dedupe(platformCredentialsPaths(platform))

export let resolveCredentialsPath = (platform: Platform) => {
  let candidates = resolveCredentialsPaths(platform)
  return candidates.find(x => fs.existsSync(x)) ?? candidates[0]
}

export let resolveAllTokenDirs = (platform: Platform) => dedupe(platformTokenDirs(platform))

export let resolveTokenReadPathsForAccount = (account: string, platform: Platform) =>
  resolveAllTokenDirs(platform).map(dir => path.resolve(dir, `${account}${TOKEN_FILE_EXTENSION}`))

export let resolveTokenReadPathForAccount = (account: string, platform: Platform) => {
  let candidates = resolveTokenReadPathsForAccount(account, platform)
  let existing = candidates.find(x => fs.existsSync(x))
  if (!existing) {
    throw new Error(`Missing token for account "${account}". Checked: ${candidates.join(", ")}`)
  }
  return existing
}

export let resolveTokenWriteDir = (platform: Platform) => path.resolve(PWD_CONFIG_DIR, platform, "tokens")

export let resolveTokenWritePathForAccount = (account: string, platform: Platform) =>
  path.resolve(resolveTokenWriteDir(platform), `${account}${TOKEN_FILE_EXTENSION}`)

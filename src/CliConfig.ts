import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export let DEFAULT_ACCOUNT = "default"

export let APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export let LOCAL_CONFIG_DIRNAME = ".mailmon"
export let PWD_CONFIG_DIR = path.resolve(process.cwd(), LOCAL_CONFIG_DIRNAME)
export let APP_CONFIG_DIR = path.resolve(APP_DIR, LOCAL_CONFIG_DIRNAME)
export let PWD_CREDENTIALS_PATH = path.resolve(PWD_CONFIG_DIR, "credentials.json")
export let PWD_TOKENS_DIR = path.resolve(PWD_CONFIG_DIR, "tokens")
export let APP_CREDENTIALS_PATH = path.resolve(APP_CONFIG_DIR, "credentials.json")
export let APP_TOKENS_DIR = path.resolve(APP_CONFIG_DIR, "tokens")
export let GLOBAL_CONFIG_DIR = path.resolve(os.homedir(), ".mailmon")
export let GLOBAL_CREDENTIALS_PATH = path.resolve(GLOBAL_CONFIG_DIR, "credentials.json")
export let GLOBAL_TOKENS_DIR = path.resolve(GLOBAL_CONFIG_DIR, "tokens")
export let TOKEN_FILE_EXTENSION = ".json"

export let GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
]

let dedupe = (paths: string[]) => Array.from(new Set(paths.map(x => path.resolve(x))))

export let resolveCredentialsPaths = () =>
  dedupe([PWD_CREDENTIALS_PATH, APP_CREDENTIALS_PATH, GLOBAL_CREDENTIALS_PATH])

export let resolveCredentialsPath = () => {
  let candidates = resolveCredentialsPaths()
  return candidates.find(x => fs.existsSync(x)) ?? GLOBAL_CREDENTIALS_PATH
}

export let resolveTokenReadPathsForAccount = (account: string) =>
  resolveAllTokenDirs().map(dir => path.resolve(dir, `${account}${TOKEN_FILE_EXTENSION}`))

export let resolveTokenReadPathForAccount = (account: string) => {
  let candidates = resolveTokenReadPathsForAccount(account)
  let existing = candidates.find(x => fs.existsSync(x))
  if (!existing) {
    throw new Error(`Missing token for account "${account}". Checked: ${candidates.join(", ")}`)
  }
  return existing
}

export let resolveTokenWriteDir = () => {
  return PWD_TOKENS_DIR
}

export let resolveTokenWritePathForAccount = (account: string) =>
  path.resolve(resolveTokenWriteDir(), `${account}${TOKEN_FILE_EXTENSION}`)

export let resolveAllTokenDirs = () => dedupe([PWD_TOKENS_DIR, APP_TOKENS_DIR, GLOBAL_TOKENS_DIR])

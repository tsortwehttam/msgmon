import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import {
  resolveCredentialsPath,
  resolveCredentialsPaths,
  resolveAllTokenDirs,
  resolveTokenWriteDir,
  resolveTokenWritePathForAccount,
  TOKEN_FILE_EXTENSION,
  GMAIL_SCOPES,
  PWD_CONFIG_DIR,
  currentWorkspaceDir,
} from "../CliConfig"
import { DEFAULT_GMAIL_SETUP_QUERY } from "../defaults"
import { inferWorkspaceAccounts } from "../workspace/accounts"
import { initWorkspace, loadWorkspaceConfig, listWorkspaceIds } from "../workspace/store"
import { pullWorkspaceMessages } from "../workspace/runtime"

// ---------------------------------------------------------------------------
// Options type
// ---------------------------------------------------------------------------

export type SetupOptions = {
  workspace?: string
  since?: string
  until?: string
  yes?: boolean
  gmailAccounts?: string
  slackAccounts?: string
  slackToken?: string
  slackMode?: string
  slackChannels?: string
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

let rl: readline.Interface | undefined
let autoMode = false

let prompt = async (question: string): Promise<string> => {
  if (autoMode) return ""
  let answer = await rl!.question(question)
  return answer.trim()
}

let confirm = async (question: string, defaultYes = true): Promise<boolean> => {
  if (autoMode) return defaultYes
  let hint = defaultYes ? "[Y/n]" : "[y/N]"
  let answer = await prompt(`${question} ${hint} `)
  if (answer === "") return defaultYes
  return answer.toLowerCase().startsWith("y")
}

let waitForEnter = async (message = "Press Enter to continue...") => {
  if (autoMode) return
  await prompt(message)
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

let ok = (msg: string) => console.log(`[ok] ${msg}`)
let skip = (msg: string) => console.log(`[skip] ${msg}`)
let info = (msg: string) => console.log(`[..] ${msg}`)
let fail = (msg: string) => console.log(`[!!] ${msg}`)
let step = (n: number, title: string) => console.log(`[${n}] ${title}`)

// ---------------------------------------------------------------------------
// Gmail credentials check
// ---------------------------------------------------------------------------

let checkGmailCredentials = async (): Promise<boolean> => {
  let candidates = resolveCredentialsPaths("gmail")
  let found = candidates.find(p => fs.existsSync(p))

  if (found) {
    try {
      let raw = JSON.parse(fs.readFileSync(found, "utf8"))
      let c = raw.installed ?? raw.web
      if (c?.client_id && c?.client_secret) {
        ok(`Gmail credentials found: ${found}`)
        return true
      }
      fail(`Gmail credentials file exists but is missing client_id or client_secret: ${found}`)
    } catch {
      fail(`Gmail credentials file exists but is not valid JSON: ${found}`)
    }
  } else {
    fail("No Gmail credentials.json found.")
  }

  if (autoMode) return false

  console.log(`To create Gmail OAuth credentials:
1. Go to https://console.cloud.google.com/ — create/select a project
2. Enable the Gmail API (APIs & Services > Library)
3. Configure OAuth consent screen (External, add gmail.readonly/modify/send scopes)
4. Create OAuth client ID (Desktop app) under Credentials
5. Download the JSON and save it as: ${candidates[0]}`)

  await waitForEnter("Press Enter after saving credentials.json...")

  // Re-check
  let recheck = candidates.find(p => fs.existsSync(p))
  if (recheck) {
    try {
      let raw = JSON.parse(fs.readFileSync(recheck, "utf8"))
      let c = raw.installed ?? raw.web
      if (c?.client_id && c?.client_secret) {
        ok(`Gmail credentials found: ${recheck}`)
        return true
      }
    } catch { /* fall through */ }
  }

  fail("Still no valid Gmail credentials.json found.")
  console.log("You can re-run `msgmon setup` after placing the file.")
  return false
}

// ---------------------------------------------------------------------------
// Gmail token check & auth
// ---------------------------------------------------------------------------

let listGmailTokens = (): string[] => {
  let dirs = resolveAllTokenDirs("gmail")
  let accounts = new Set<string>()
  for (let dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(TOKEN_FILE_EXTENSION)) {
        accounts.add(entry.name.slice(0, -TOKEN_FILE_EXTENSION.length))
      }
    }
  }
  return Array.from(accounts).sort()
}

let authorizeOneGmailAccount = async (): Promise<boolean> => {
  info("A browser window will open. Sign in and grant access.")

  try {
    let { authenticate } = await import("@google-cloud/local-auth")
    let { google } = await import("googleapis")
    let credentialsPath = resolveCredentialsPath("gmail")
    let tokenDir = resolveTokenWriteDir("gmail")
    fs.mkdirSync(tokenDir, { recursive: true })
    let auth = await authenticate({ keyfilePath: credentialsPath, scopes: GMAIL_SCOPES })

    // Use the email address as the account name
    let accountName: string
    try {
      let gmail = google.gmail({ version: "v1", auth: auth as never })
      let profile = await gmail.users.getProfile({ userId: "me" })
      accountName = profile.data.emailAddress ?? "default"
    } catch {
      accountName = "default"
    }

    let existing = listGmailTokens()
    if (existing.includes(accountName)) {
      ok(`Account "${accountName}" is already authorized.`)
      return true
    }

    let tokenPath = resolveTokenWritePathForAccount(accountName, "gmail")
    fs.writeFileSync(tokenPath, JSON.stringify(auth.credentials, null, 2))
    ok(`Saved token for ${accountName}`)
    return true
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err)
    fail(`OAuth failed: ${msg}`)
    console.log("Make sure your credentials.json is valid and try again.")
    return false
  }
}

let checkGmailTokens = async (opts: SetupOptions): Promise<boolean> => {
  let existing = listGmailTokens()
  let gmailAccounts = opts.gmailAccounts

  // Auto mode with explicit account list
  if (autoMode && gmailAccounts) {
    if (gmailAccounts === "all") {
      if (existing.length > 0) {
        ok(`Gmail account(s) already authorized: ${existing.join(", ")}`)
        return true
      }
      fail("--gmail-accounts=all but no existing Gmail tokens found.")
      return false
    }
    // Specific accounts requested
    let requested = gmailAccounts.split(",").map(s => s.trim()).filter(Boolean)
    let missing = requested.filter(a => !existing.includes(a))
    if (missing.length > 0) {
      fail(`Gmail tokens not found for: ${missing.join(", ")}. Run interactive setup or authorize these accounts first.`)
      return false
    }
    ok(`Gmail account(s) already authorized: ${requested.join(", ")}`)
    return true
  }

  // Auto mode without explicit accounts — just use what exists
  if (autoMode) {
    if (existing.length > 0) {
      ok(`Gmail account(s) already authorized: ${existing.join(", ")}`)
      return true
    }
    fail("No Gmail tokens found. Run interactive setup to authorize accounts.")
    return false
  }

  // Interactive mode
  if (existing.length > 0) {
    ok(`Gmail account(s) already authorized: ${existing.join(", ")}`)
  } else {
    info("No Gmail tokens found. Let's authorize your first account.")
    let success = await authorizeOneGmailAccount()
    if (!success) return false
  }

  // Loop to add more accounts
  while (await confirm("Add another Gmail account?", false)) {
    await authorizeOneGmailAccount()
  }

  return listGmailTokens().length > 0
}

// ---------------------------------------------------------------------------
// Slack setup (optional)
// ---------------------------------------------------------------------------

let listSlackTokens = (): string[] => {
  let dirs = resolveAllTokenDirs("slack")
  let accounts = new Set<string>()
  for (let dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(TOKEN_FILE_EXTENSION)) {
        accounts.add(entry.name.slice(0, -TOKEN_FILE_EXTENSION.length))
      }
    }
  }
  return Array.from(accounts).sort()
}

let authorizeOneSlackAccount = async (accountName?: string, mode?: string, token?: string): Promise<boolean> => {
  if (!accountName) {
    accountName = await prompt("Slack account name [default]: ")
    if (!accountName) accountName = "default"
  }

  let existing = listSlackTokens()
  if (existing.includes(accountName)) {
    ok(`Slack account "${accountName}" is already authorized.`)
    return true
  }

  if (!mode) {
    console.log("Auth mode:")
    console.log("1) Bot token — paste a token (recommended, simplest)")
    console.log("2) OAuth — browser flow (needed for search and send-as-user)")
    mode = await prompt("Mode [1]: ")
    mode = mode === "2" ? "oauth" : "bot"
  }

  if (mode === "oauth") {
    // OAuth mode
    let credPath = resolveCredentialsPath("slack")
    let hasCredentials = fs.existsSync(credPath)
    if (!hasCredentials) {
      if (autoMode) {
        fail(`Slack credentials not found at ${credPath}. Cannot run OAuth in non-interactive mode without credentials.`)
        return false
      }
      let { BOT_SCOPES, USER_SCOPES } = await import("../../platforms/slack/auth")
      console.log("To create a Slack app for OAuth:")
      console.log("1. Go to https://api.slack.com/apps > Create New App > From scratch")
      console.log("2. Name it anything (e.g. \"msgmon\") and pick your workspace")
      console.log(`3. Under OAuth & Permissions, add Bot Token Scopes: ${BOT_SCOPES.replace(/,/g, ", ")}`)
      console.log(`4. Under OAuth & Permissions, add User Token Scopes: ${USER_SCOPES.replace(/,/g, ", ")}`)
      console.log("5. Under OAuth & Permissions > Redirect URLs, add: https://tsortwehttam.github.io/msgmon/oauth")
      console.log("6. Copy Client ID and Client Secret from Basic Information")
      console.log(`7. Save as: ${credPath}`)
      console.log(`Format: { "client_id": "...", "client_secret": "..." }`)
      await waitForEnter("Press Enter after saving credentials.json...")
      if (!fs.existsSync(credPath)) {
        fail(`Slack credentials not found at ${credPath}`)
        return false
      }
    }

    info("Starting Slack OAuth flow...")
    try {
      let { parseAuthCli } = await import("../../platforms/slack/auth")
      await parseAuthCli(["--mode=oauth", `--account=${accountName}`], "msgmon slack auth", rl)
      ok("Slack OAuth complete.")
      return true
    } catch (err) {
      fail(`Slack OAuth failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // Bot token mode
  if (!token) {
    if (autoMode) {
      fail(`No --slack-token provided for account "${accountName}". Cannot prompt in non-interactive mode.`)
      return false
    }
    console.log("To get a bot token:")
    console.log("1. Go to https://api.slack.com/apps > Create New App > From scratch")
    console.log("2. Name it anything (e.g. \"msgmon\") and pick your workspace")
    console.log("3. Under OAuth & Permissions, add Bot Token Scopes: channels:history, channels:read, groups:history, groups:read, im:history, mpim:history, users:read, chat:write")
    console.log("4. Click Install to Workspace, then copy the Bot User OAuth Token")
    token = await prompt("Paste your Slack bot token (xoxb-...): ")
  }
  if (!token) {
    fail("No token provided.")
    return false
  }

  try {
    let { parseAuthCli } = await import("../../platforms/slack/auth")
    await parseAuthCli([`--token=${token}`, `--account=${accountName}`], "msgmon slack auth")
    ok("Slack bot token saved.")
    return true
  } catch (err) {
    fail(`Slack auth failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

let checkSlack = async (opts: SetupOptions): Promise<boolean> => {
  let existing = listSlackTokens()
  if (existing.length > 0) {
    ok(`Slack account(s) already authorized: ${existing.join(", ")}`)
  }

  let slackAccounts = opts.slackAccounts

  // Auto mode with explicit account list
  if (autoMode && slackAccounts) {
    if (slackAccounts === "all") {
      if (existing.length > 0) return true
      fail("--slack-accounts=all but no existing Slack tokens found.")
      return false
    }
    // Specific accounts requested
    let requested = slackAccounts.split(",").map(s => s.trim()).filter(Boolean)
    for (let name of requested) {
      if (existing.includes(name)) continue
      await authorizeOneSlackAccount(name, opts.slackMode ?? "bot", opts.slackToken)
    }
    return true
  }

  // Auto mode without explicit accounts — skip Slack setup
  if (autoMode) {
    if (existing.length === 0) skip("Skipping Slack setup (no --slack-accounts flag).")
    return true
  }

  // Interactive mode
  let hasAny = existing.length > 0
  let promptMsg = hasAny ? "Add another Slack account?" : "Set up Slack integration?"

  if (!await confirm(promptMsg, !hasAny)) {
    if (!hasAny) skip("Skipping Slack setup.")
    return true
  }

  await authorizeOneSlackAccount()

  // Loop to add more
  while (await confirm("Add another Slack account?", false)) {
    await authorizeOneSlackAccount()
  }

  return true
}

// ---------------------------------------------------------------------------
// Slack channel picker
// ---------------------------------------------------------------------------

let normalizeSlackChannelName = (value: string) => value.trim().replace(/^#/, "").toLowerCase()

let parseSlackChannelsFlag = (flag: string): Record<string, string[]> => {
  let result: Record<string, string[]> = {}
  for (let entry of flag.split(",").map(s => s.trim()).filter(Boolean)) {
    let colonIdx = entry.indexOf(":")
    let account: string
    let channel: string
    if (colonIdx !== -1 && !entry.startsWith("#")) {
      // account:#channel format
      account = entry.slice(0, colonIdx)
      channel = entry.slice(colonIdx + 1)
    } else {
      // bare #channel — assign to wildcard
      account = "*"
      channel = entry
    }
    channel = channel.startsWith("#") ? channel : `#${channel}`
    if (channel.length > 1) {
      ;(result[account] ??= []).push(channel)
    }
  }
  return result
}

let pickSlackChannelsForAccount = async (accountName: string): Promise<string[]> => {
  try {
    let { slackClients, slackReadClient } = await import("../../platforms/slack/slackClient")
    let clients = slackClients(accountName)
    let reader = slackReadClient(clients)

    let channels: Array<{ id: string; name: string }> = []
    let skippedUnreadable = 0
    let cursor: string | undefined
    while (true) {
      let res = await reader.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
        exclude_archived: true,
        cursor,
      })
      for (let ch of res.channels ?? []) {
        if (!ch.id || !ch.name) continue
        if (clients.user || ch.is_member) {
          channels.push({ id: ch.id, name: ch.name })
        } else {
          skippedUnreadable += 1
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined
      if (!cursor) break
    }

    if (channels.length === 0) {
      fail(clients.user
        ? `[${accountName}] No Slack channels found for this user token.`
        : `[${accountName}] No Slack channels found that this bot is a member of.`)
      if (skippedUnreadable > 0) {
        console.log("Invite the bot to the channels you want monitored, then run setup again.")
      }
      return []
    }

    let names = channels.map(c => `#${c.name}`)
    console.log(`[${accountName}] Found ${channels.length} channels: ${names.join(", ")}`)
    if (skippedUnreadable > 0) {
      info(`[${accountName}] Skipped ${skippedUnreadable} channel(s) the bot is not a member of.`)
    }

    if (autoMode) return names

    if (await confirm(`[${accountName}] Monitor all of these channels?`, true)) {
      return names
    }

    let knownByName = new Map(channels.map(channel => [normalizeSlackChannelName(channel.name), `#${channel.name}`]))
    while (true) {
      let input = await prompt(`[${accountName}] Enter channels to monitor (comma-separated, e.g. #general,#engineering): `)
      let raw = input.split(",").map(s => s.trim()).filter(Boolean)
      if (raw.length === 0) {
        console.log("No channels entered.")
        continue
      }

      let picked: string[] = []
      let invalid = false
      for (let entry of raw) {
        let resolved = knownByName.get(normalizeSlackChannelName(entry))
        if (!resolved) {
          invalid = true
          break
        }
        picked.push(resolved)
      }

      if (invalid) {
        fail("Your list included a channel not here, please try again.")
        continue
      }

      return Array.from(new Set(picked))
    }
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("missing_scope")) {
      let { BOT_SCOPE_LIST, USER_SCOPE_LIST } = await import("../../platforms/slack/auth")
      fail(`[${accountName}] Could not list Slack channels: your Slack token is missing required scopes.`)
      console.log(`Bot scopes needed: ${BOT_SCOPE_LIST.join(", ")}`)
      console.log(`User scopes needed: ${USER_SCOPE_LIST.join(", ")}`)
      console.log("Re-run Slack OAuth auth for this account to refresh the saved token scopes:")
      console.log(`  msgmon slack auth --mode=oauth --account=${JSON.stringify(accountName)}`)
      return []
    }
    fail(`[${accountName}] Could not list Slack channels: ${msg}`)
    return []
  }
}

let pickSlackChannels = async (opts: SetupOptions): Promise<Record<string, string[]>> => {
  let slackAccounts = listSlackTokens()
  if (slackAccounts.length === 0) return {}

  let slackChannelsFlag = opts.slackChannels

  // Auto mode with explicit channel list (no API call needed)
  if (autoMode && slackChannelsFlag && slackChannelsFlag !== "all") {
    let parsed = parseSlackChannelsFlag(slackChannelsFlag)
    // Expand wildcard entries to all accounts
    if (parsed["*"]) {
      let wildcard = parsed["*"]
      delete parsed["*"]
      for (let account of slackAccounts) {
        parsed[account] = [...(parsed[account] ?? []), ...wildcard]
      }
    }
    return parsed
  }

  // Pick channels per account
  let result: Record<string, string[]> = {}
  for (let accountName of slackAccounts) {
    let channels = await pickSlackChannelsForAccount(accountName)
    if (channels.length > 0) {
      result[accountName] = channels
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Server workspace setup
// ---------------------------------------------------------------------------

let formatSlackChannels = (channels?: Record<string, string[]>): string => {
  if (!channels || !Object.keys(channels).length) return ""
  return Object.entries(channels).map(([account, chs]) => `${account}: ${chs.join(", ")}`).join("; ")
}

let setupWorkspace = async (workspaceId: string, slackChannels?: Record<string, string[]>): Promise<boolean> => {
  let existing = listWorkspaceIds()

  if (existing.includes(workspaceId)) {
    ok(`Server workspace already exists in ${process.cwd()}.`)
    try {
      let config = loadWorkspaceConfig(workspaceId)
      info(`Accounts: ${config.accounts.join(", ")}`)
      info(`Query: ${config.query}`)
      let chStr = formatSlackChannels(config.slackChannels)
      if (chStr) info(`Slack channels: ${chStr}`)
      return true
    } catch {
      return true
    }
  }

  let accounts = inferWorkspaceAccounts()
  if (accounts.length === 0) {
    fail("No accounts found to create a server workspace. Complete auth setup first.")
    return false
  }

  info(`Detected accounts: ${accounts.join(", ")}`)

  try {
    let result = initWorkspace(workspaceId, { accounts, slackChannels })
    ok(`Created server workspace at ${result.path}`)
    info(`Accounts: ${result.config.accounts.join(", ")}`)
    info(`Query: ${result.config.query}`)
    return true
  } catch (err) {
    fail(`Failed to create server workspace: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Initial server pull
// ---------------------------------------------------------------------------

let pullMessagesForSetup = async (workspaceId: string, params: { since?: string; until?: string } = {}): Promise<boolean> => {
  let config = loadWorkspaceConfig(workspaceId)
  let setupQuery = DEFAULT_GMAIL_SETUP_QUERY
  info("Pulling initial messages...")
  info(`Gmail query: ${setupQuery}`)
  let chStr = formatSlackChannels(config.slackChannels)
  if (chStr) info(`Slack channels: ${chStr}`)
  if (params.since) info(`Since: ${params.since}`)
  if (params.until) info(`Until: ${params.until}`)
  let result = await pullWorkspaceMessages({
    workspaceId,
    maxResults: 200,
    markRead: false,
    saveAttachments: false,
    verbose: false,
    query: setupQuery,
    since: params.since,
    until: params.until,
  })

  if (result.scanned > 0 || result.ingested > 0) {
    ok(`${result.scanned} message(s) scanned, ${result.ingested} written to messages.jsonl for ${result.since} to ${result.until}.`)
  }
  for (let stats of result.accountStats) {
    info(`[account ${stats.account}] scanned=${stats.scanned} written=${stats.ingested} skipped=${stats.skipped}`)
  }

  for (let err of result.errors) {
    if (err.includes("Precondition check failed") || err.includes("invalid_grant")) {
      fail(`${err}`)
      console.log("Your token may have expired or been revoked.")
      if (autoMode) {
        fail("Cannot re-authorize in non-interactive mode. Re-run interactive setup or refresh tokens manually.")
      } else if (await confirm("Re-authorize Gmail now?", true)) {
        let success = await authorizeOneGmailAccount()
        if (success) return pullMessagesForSetup(workspaceId, params)
      }
    } else if (err.includes("Missing token")) {
      fail(`${err}`)
      console.log("Make sure you've authorized the accounts in this server workspace.")
    } else {
      fail(err)
    }
  }

  return result.errors.length === 0
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

export let runSetup = async (options: SetupOptions) => {
  let workspaceId = options.workspace ?? "default"
  autoMode = !!options.yes

  if (!autoMode) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
  }

  try {
    console.log(autoMode ? "msgmon setup — non-interactive mode" : "msgmon setup — interactive walkthrough")

    // Step 1: Gmail credentials
    step(1, "Gmail Credentials")

    let hasCredentials = await checkGmailCredentials()
    if (!hasCredentials) {
      if (autoMode) {
        info("Continuing without Gmail credentials.")
      } else {
        let cont = await confirm("Continue setup without Gmail credentials?", false)
        if (!cont) {
          console.log("Setup aborted. Re-run `msgmon setup` when ready.")
          return
        }
      }
    }

    // Step 2: Gmail token
    let hasGmailToken = false
    if (hasCredentials) {
      step(2, "Gmail Authorization")
      hasGmailToken = await checkGmailTokens(options)
    } else {
      step(2, "Gmail Authorization")
      skip("Skipped (no credentials).")
    }

    // Step 3: Slack (optional)
    step(3, "Slack")
    await checkSlack(options)

    // Check we have at least one account
    let allAccounts = inferWorkspaceAccounts()
    if (allAccounts.length === 0) {
      fail("No platform accounts are configured. You need at least one to continue.")
      console.log("Set up Gmail credentials + auth, or add a Slack bot token, then re-run setup.")
      return
    }

    ok(`Found ${allAccounts.length} account(s): ${allAccounts.join(", ")}`)

    // Step 4: Slack channels
    let slackChannels: Record<string, string[]> | undefined
    if (allAccounts.some(a => a.startsWith("slack:"))) {
      step(4, "Slack Channels")
      slackChannels = await pickSlackChannels(options)
      let chStr = formatSlackChannels(slackChannels)
      if (chStr) {
        ok(`Monitoring: ${chStr}`)
      } else {
        skip("No Slack channels selected.")
      }
    }

    // Step 5: Server workspace
    step(5, "Server Workspace")
    let hasWorkspace = await setupWorkspace(workspaceId, slackChannels)
    if (!hasWorkspace) {
      console.log("Setup could not create the server workspace. Fix the issues above and re-run.")
      return
    }

    // Step 6: Initial pull
    step(6, "Initial Message Pull")
    let pulled = await pullMessagesForSetup(workspaceId, {
      since: options.since,
      until: options.until,
    })
    if (!pulled) {
      if (autoMode) {
        info("Continuing despite pull errors.")
      } else {
        let cont = await confirm("Continue anyway?", true)
        if (!cont) {
          console.log("Setup paused. Fix the issue and re-run `msgmon setup`.")
          return
        }
      }
    }

    // Done — print instructions
    let workspaceDir = currentWorkspaceDir()
    console.log("Setup complete! To start, run in two terminals:")
    console.log(`  msgmon serve ${JSON.stringify(workspaceDir)}`)
    console.log(`  msgmon client start --server=http://127.0.0.1:3271 --dir=/tmp/agent-sandbox --agent-command='codex .'`)
    console.log(`The server workspace's local server config is stored under ${JSON.stringify(path.resolve(workspaceDir, ".msgmon", "serve.json"))}.`)
  } finally {
    rl?.close()
  }
}

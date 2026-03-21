import fs from "node:fs"
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
} from "../CliConfig"
import { inferWorkspaceAccounts } from "../workspace/accounts"
import { initWorkspace, loadWorkspaceConfig, listWorkspaceIds } from "../workspace/store"
import { refreshWorkspace, syncWorkspaceContext } from "../workspace/runtime"

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

let rl: readline.Interface

let prompt = async (question: string): Promise<string> => {
  let answer = await rl.question(question)
  return answer.trim()
}

let confirm = async (question: string, defaultYes = true): Promise<boolean> => {
  let hint = defaultYes ? "[Y/n]" : "[y/N]"
  let answer = await prompt(`${question} ${hint} `)
  if (answer === "") return defaultYes
  return answer.toLowerCase().startsWith("y")
}

let waitForEnter = async (message = "Press Enter to continue...") => {
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

let checkGmailTokens = async (): Promise<boolean> => {
  let existing = listGmailTokens()

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

let authorizeOneSlackAccount = async (): Promise<boolean> => {
  let accountName = await prompt("Slack account name [default]: ")
  if (!accountName) accountName = "default"

  let existing = listSlackTokens()
  if (existing.includes(accountName)) {
    ok(`Slack account "${accountName}" is already authorized.`)
    return true
  }

  console.log("Auth mode:")
  console.log("1) Bot token — paste a token (recommended, simplest)")
  console.log("2) OAuth — browser flow (needed for search and send-as-user)")
  let mode = await prompt("Mode [1]: ")

  if (mode === "2") {
    // OAuth mode
    let credPath = resolveCredentialsPath("slack")
    let hasCredentials = fs.existsSync(credPath)
    if (!hasCredentials) {
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
  console.log("To get a bot token:")
  console.log("1. Go to https://api.slack.com/apps > Create New App > From scratch")
  console.log("2. Name it anything (e.g. \"msgmon\") and pick your workspace")
  console.log("3. Under OAuth & Permissions, add Bot Token Scopes: channels:history, channels:read, groups:history, groups:read, im:history, mpim:history, users:read, chat:write")
  console.log("4. Click Install to Workspace, then copy the Bot User OAuth Token")
  let token = await prompt("Paste your Slack bot token (xoxb-...): ")
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

let checkSlack = async (): Promise<boolean> => {
  let existing = listSlackTokens()
  if (existing.length > 0) {
    ok(`Slack account(s) already authorized: ${existing.join(", ")}`)
  }

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

let pickSlackChannels = async (): Promise<string[]> => {
  let slackAccounts = listSlackTokens()
  if (slackAccounts.length === 0) return []

  let accountName = slackAccounts[0]
  try {
    let { slackClients, slackReadClient } = await import("../../platforms/slack/slackClient")
    let clients = slackClients(accountName)
    let reader = slackReadClient(clients)

    // Only offer channels the bot can actually read.
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
        ? "No Slack channels found for this user token."
        : "No Slack channels found that this bot is a member of.")
      if (skippedUnreadable > 0) {
        console.log("Invite the bot to the channels you want monitored, then run setup again.")
      }
      return []
    }

    let names = channels.map(c => `#${c.name}`)
    console.log(`Found ${channels.length} channels: ${names.join(", ")}`)
    if (skippedUnreadable > 0) {
      info(`Skipped ${skippedUnreadable} channel(s) the bot is not a member of.`)
    }

    if (await confirm("Monitor all of these channels?", true)) {
      return names
    }

    let input = await prompt("Enter channels to monitor (comma-separated, e.g. #general,#engineering): ")
    let picked = input.split(",").map(s => s.trim()).filter(Boolean)
    if (picked.length > 0) return picked

    console.log("No channels entered.")
    return pickSlackChannels()
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("missing_scope")) {
      let { BOT_SCOPE_LIST, USER_SCOPE_LIST } = await import("../../platforms/slack/auth")
      fail("Could not list Slack channels: your Slack token is missing required scopes.")
      console.log(`Bot scopes needed: ${BOT_SCOPE_LIST.join(", ")}`)
      console.log(`User scopes needed: ${USER_SCOPE_LIST.join(", ")}`)
      console.log("Re-run Slack OAuth auth for this account to refresh the saved token scopes:")
      console.log(`  msgmon slack auth --mode=oauth --account=${JSON.stringify(accountName)}`)
      return []
    }
    fail(`Could not list Slack channels: ${msg}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

let setupWorkspace = async (workspaceId: string, slackChannels?: string[]): Promise<boolean> => {
  let existing = listWorkspaceIds()

  if (existing.includes(workspaceId)) {
    ok(`Workspace "${workspaceId}" already exists.`)
    try {
      let config = loadWorkspaceConfig(workspaceId)
      info(`Accounts: ${config.accounts.join(", ")}`)
      info(`Query: ${config.query}`)
      if (config.slackChannels?.length) info(`Slack channels: ${config.slackChannels.join(", ")}`)
      return true
    } catch {
      return true
    }
  }

  let accounts = inferWorkspaceAccounts()
  if (accounts.length === 0) {
    fail("No accounts found to create workspace. Complete auth setup first.")
    return false
  }

  info(`Detected accounts: ${accounts.join(", ")}`)

  try {
    let result = initWorkspace(workspaceId, { accounts, slackChannels })
    ok(`Created workspace "${workspaceId}" at ${result.path}`)
    info(`Accounts: ${result.config.accounts.join(", ")}`)
    info(`Query: ${result.config.query}`)
    return true
  } catch (err) {
    fail(`Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Seed workspace
// ---------------------------------------------------------------------------

let seedWorkspace = async (workspaceId: string): Promise<boolean> => {
  info("Seeding workspace (recording current message IDs without downloading)...")
  let result = await refreshWorkspace({
    workspaceId,
    maxResults: 100,
    markRead: false,
    saveAttachments: false,
    seed: true,
    verbose: false,
  })

  if (result.scanned > 0 || result.ingested > 0) {
    ok(`${result.scanned} message(s) scanned, ${result.ingested} recorded.`)
  }

  for (let err of result.errors) {
    if (err.includes("Precondition check failed") || err.includes("invalid_grant")) {
      fail(`${err}`)
      console.log("Your token may have expired or been revoked.")
      if (await confirm("Re-authorize Gmail now?", true)) {
        let success = await authorizeOneGmailAccount()
        if (success) return seedWorkspace(workspaceId)
      }
    } else if (err.includes("Missing token")) {
      fail(`${err}`)
      console.log("Make sure you've authorized the accounts in this workspace.")
    } else {
      fail(err)
    }
  }

  return result.errors.length === 0
}

let syncWorkspaceContextHistory = async (workspaceId: string): Promise<boolean> => {
  info("Syncing recent context into workspace/context for the agent...")
  let result = await syncWorkspaceContext({
    workspaceId,
    maxResults: 200,
    saveAttachments: false,
    verbose: false,
  })

  if (result.scanned > 0 || result.ingested > 0) {
    ok(`${result.scanned} context message(s) scanned, ${result.ingested} written.`)
  }

  for (let err of result.errors) fail(err)
  return result.errors.length === 0
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

export let runSetup = async (options: { workspace?: string }) => {
  let workspaceId = options.workspace ?? "default"

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    console.log("msgmon setup — interactive walkthrough")

    // Step 1: Gmail credentials
    step(1, "Gmail Credentials")

    let hasCredentials = await checkGmailCredentials()
    if (!hasCredentials) {
      let cont = await confirm("Continue setup without Gmail credentials?", false)
      if (!cont) {
        console.log("Setup aborted. Re-run `msgmon setup` when ready.")
        return
      }
    }

    // Step 2: Gmail token
    let hasGmailToken = false
    if (hasCredentials) {
      step(2, "Gmail Authorization")
      hasGmailToken = await checkGmailTokens()
    } else {
      step(2, "Gmail Authorization")
      skip("Skipped (no credentials).")
    }

    // Step 3: Slack (optional)
    step(3, "Slack")
    await checkSlack()

    // Check we have at least one account
    let allAccounts = inferWorkspaceAccounts()
    if (allAccounts.length === 0) {
      fail("No platform accounts are configured. You need at least one to continue.")
      console.log("Set up Gmail credentials + auth, or add a Slack bot token, then re-run setup.")
      return
    }

    ok(`Found ${allAccounts.length} account(s): ${allAccounts.join(", ")}`)

    // Step 4: Slack channels
    let slackChannels: string[] | undefined
    if (allAccounts.some(a => a.startsWith("slack:"))) {
      step(4, "Slack Channels")
      slackChannels = await pickSlackChannels()
      if (slackChannels.length > 0) {
        ok(`Monitoring: ${slackChannels.join(", ")}`)
      } else {
        skip("No Slack channels selected.")
      }
    }

    // Step 5: Workspace
    step(5, `Workspace "${workspaceId}"`)
    let hasWorkspace = await setupWorkspace(workspaceId, slackChannels)
    if (!hasWorkspace) {
      console.log("Setup could not create workspace. Fix the issues above and re-run.")
      return
    }

    // Step 6: Seed
    step(6, "Seed Workspace")
    let seeded = await seedWorkspace(workspaceId)
    if (!seeded) {
      let cont = await confirm("Continue anyway?", true)
      if (!cont) {
        console.log("Setup paused. Fix the issue and re-run `msgmon setup`.")
        return
      }
    }

    // Step 7: Context
    step(7, "Sync Context")
    let syncedContext = await syncWorkspaceContextHistory(workspaceId)
    if (!syncedContext) {
      let cont = await confirm("Continue anyway?", true)
      if (!cont) {
        console.log("Setup paused. Fix the issue and re-run `msgmon setup`.")
        return
      }
    }

    // Done — print instructions
    console.log("Setup complete! To start, run in two terminals:")
    console.log(`  msgmon serve`)
    console.log(`  msgmon session start --workspace=${workspaceId} --agent-command='codex .'`)
    console.log("Auth token is auto-generated in .msgmon/serve.json and read by session.")
  } finally {
    rl.close()
  }
}

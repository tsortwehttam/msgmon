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
import { refreshWorkspace } from "../workspace/runtime"

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

let ok = (msg: string) => console.log(`  [ok] ${msg}`)
let skip = (msg: string) => console.log(`  [skip] ${msg}`)
let info = (msg: string) => console.log(`  [..] ${msg}`)
let fail = (msg: string) => console.log(`  [!!] ${msg}`)
let step = (n: number, title: string) => console.log(`\n--- Step ${n}: ${title} ---\n`)

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

  console.log(`
  To create Gmail OAuth credentials:

    1. Go to https://console.cloud.google.com/
    2. Create a new project (or select an existing one)
    3. Enable the Gmail API:
       APIs & Services > Library > search "Gmail API" > Enable
    4. Configure the OAuth consent screen:
       APIs & Services > OAuth consent screen > External > fill required fields
       Add scopes: gmail.readonly, gmail.modify, gmail.send
    5. Create OAuth credentials:
       APIs & Services > Credentials > Create Credentials > OAuth client ID
       Application type: Desktop app
    6. Download the JSON file and save it as:

       ${candidates[0]}
`)

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
  console.log("  You can re-run `msgmon setup` after placing the file.\n")
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

let checkGmailTokens = async (): Promise<boolean> => {
  let existing = listGmailTokens()

  if (existing.length > 0) {
    ok(`Gmail account(s) already authorized: ${existing.join(", ")}`)
    let addMore = await confirm("Add another Gmail account?", false)
    if (!addMore) return true
  } else {
    info("No Gmail tokens found. Let's authorize your first account.")
  }

  let accountName = await prompt("  Account name (e.g. personal, work) [default]: ")
  if (!accountName) accountName = "default"

  info(`Starting OAuth flow for account "${accountName}"...`)
  info("A browser window will open. Sign in and grant access.\n")

  try {
    let { authenticate } = await import("@google-cloud/local-auth")
    let credentialsPath = resolveCredentialsPath("gmail")
    let tokenDir = resolveTokenWriteDir("gmail")
    let tokenPath = resolveTokenWritePathForAccount(accountName, "gmail")
    fs.mkdirSync(tokenDir, { recursive: true })
    let auth = await authenticate({ keyfilePath: credentialsPath, scopes: GMAIL_SCOPES })
    fs.writeFileSync(tokenPath, JSON.stringify(auth.credentials, null, 2))
    ok(`Saved token: ${tokenPath}`)
    return true
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err)
    fail(`OAuth failed: ${msg}`)
    console.log("  Make sure your credentials.json is valid and try again.\n")
    return false
  }
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

let checkSlack = async (): Promise<boolean> => {
  let existing = listSlackTokens()
  if (existing.length > 0) {
    ok(`Slack account(s) already authorized: ${existing.join(", ")}`)
    return true
  }

  let wantSlack = await confirm("Set up Slack integration?", false)
  if (!wantSlack) {
    skip("Skipping Slack setup.")
    return true
  }

  let accountName = await prompt("  Slack account name [default]: ")
  if (!accountName) accountName = "default"

  console.log(`
  Choose auth mode:
    1) Bot token — paste an xoxb-... token (simplest)
    2) OAuth     — browser flow (enables search & send-as-user)
`)

  let mode = await prompt("  Mode [1]: ")

  if (mode === "2") {
    // OAuth mode
    let credPath = resolveCredentialsPath("slack")
    let hasCredentials = fs.existsSync(credPath)
    if (!hasCredentials) {
      console.log(`
  For Slack OAuth, save your app's client_id and client_secret as:
    ${credPath}

  Format: { "client_id": "...", "client_secret": "..." }
`)
      await waitForEnter("Press Enter after saving credentials.json...")
      if (!fs.existsSync(credPath)) {
        fail(`Slack credentials not found at ${credPath}`)
        return false
      }
    }

    info("Starting Slack OAuth flow...")
    try {
      let { parseAuthCli } = await import("../../platforms/slack/auth")
      await parseAuthCli(["--mode=oauth", `--account=${accountName}`], "msgmon slack auth")
      ok("Slack OAuth complete.")
      return true
    } catch (err) {
      fail(`Slack OAuth failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // Bot token mode
  let token = await prompt("  Paste your Slack bot token (xoxb-...): ")
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

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

let setupWorkspace = async (workspaceId: string): Promise<boolean> => {
  let existing = listWorkspaceIds()

  if (existing.includes(workspaceId)) {
    ok(`Workspace "${workspaceId}" already exists.`)
    try {
      let config = loadWorkspaceConfig(workspaceId)
      info(`  Accounts: ${config.accounts.join(", ")}`)
      info(`  Query: ${config.query}`)
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
    let result = initWorkspace(workspaceId, { accounts })
    ok(`Created workspace "${workspaceId}" at ${result.path}`)
    info(`  Accounts: ${result.config.accounts.join(", ")}`)
    info(`  Query: ${result.config.query}`)
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
  try {
    let result = await refreshWorkspace({
      workspaceId,
      maxResults: 100,
      markRead: false,
      saveAttachments: false,
      seed: true,
      verbose: false,
    })
    ok(`Seed complete. ${result.scanned} message(s) scanned, ${result.ingested} recorded.`)
    return true
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("Missing token")) {
      fail(`Seed failed — missing token. Make sure you've authorized the accounts in this workspace.`)
      console.log(`  Error: ${msg}\n`)
    } else {
      fail(`Seed failed: ${msg}`)
    }
    return false
  }
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
    console.log("\nmsgmon setup")
    console.log("============\n")
    console.log("This will walk you through setting up msgmon from scratch.\n")

    // Step 1: Gmail credentials
    step(1, "Gmail Credentials")

    let hasCredentials = await checkGmailCredentials()
    if (!hasCredentials) {
      let cont = await confirm("Continue setup without Gmail credentials?", false)
      if (!cont) {
        console.log("\nSetup aborted. Re-run `msgmon setup` when ready.\n")
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
    step(3, "Slack (optional)")
    await checkSlack()

    // Check we have at least one account
    let allAccounts = inferWorkspaceAccounts()
    if (allAccounts.length === 0) {
      fail("\nNo platform accounts are configured. You need at least one to continue.")
      console.log("  Set up Gmail credentials + auth, or add a Slack bot token, then re-run setup.\n")
      return
    }

    ok(`Found ${allAccounts.length} account(s): ${allAccounts.join(", ")}`)

    // Step 4: Workspace
    step(4, `Workspace "${workspaceId}"`)
    let hasWorkspace = await setupWorkspace(workspaceId)
    if (!hasWorkspace) {
      console.log("\nSetup could not create workspace. Fix the issues above and re-run.\n")
      return
    }

    // Step 5: Seed
    step(5, "Seed Workspace")
    let seeded = await seedWorkspace(workspaceId)
    if (!seeded) {
      let cont = await confirm("Continue anyway?", true)
      if (!cont) {
        console.log("\nSetup paused. Fix the issue and re-run `msgmon setup`.\n")
        return
      }
    }

    // Done — print instructions
    console.log("\n--- Setup Complete ---\n")
    console.log("To start the server and agent, run these in two terminals:\n")
    console.log("  Terminal 1 (server):")
    console.log(`    cd ${process.cwd()}`)
    console.log("    msgmon serve\n")
    console.log("  Terminal 2 (agent):")
    console.log(`    cd ${process.cwd()}`)
    console.log(`    msgmon session start --workspace=${workspaceId} --agent-command='codex .'\n`)
    console.log("The server auto-generates an auth token and saves it to .msgmon/serve.json.")
    console.log("The session command reads it automatically — no manual token copy needed.\n")
  } finally {
    rl.close()
  }
}

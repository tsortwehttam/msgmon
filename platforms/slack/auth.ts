import fs from "node:fs"
import crypto from "node:crypto"
import { exec } from "node:child_process"
import readline from "node:readline/promises"
import { URL } from "node:url"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { WebClient } from "@slack/web-api"
import type { Argv } from "yargs"
import {
  DEFAULT_ACCOUNT,
  resolveCredentialsPath,
  resolveTokenWriteDir,
  resolveTokenWritePathForAccount,
} from "../../src/CliConfig"
import { verboseLog } from "../../src/Verbose"
import type { SlackTokenFile } from "./slackClient"

// ---------------------------------------------------------------------------
// Bot-token mode: user pastes a token string
// ---------------------------------------------------------------------------

let authBot = async (account: string, token: string, verbose = false) => {
  let client = new WebClient(token)
  let test = await client.auth.test()
  if (!test.ok) throw new Error(`auth.test failed: ${test.error}`)

  let tokenFile: SlackTokenFile = {
    bot_token: token,
    team_id: test.team_id,
    team_name: test.team,
  }

  let tokenDir = resolveTokenWriteDir("slack")
  let tokenPath = resolveTokenWritePathForAccount(account, "slack")
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.writeFileSync(tokenPath, JSON.stringify(tokenFile, null, 2) + "\n")

  verboseLog(verbose, "saved token", { account, tokenPath, teamId: test.team_id })
  console.log(`Authenticated as "${test.user}" in workspace "${test.team}" (${test.team_id})`)
  console.log(`Saved ${tokenPath}`)
}

// ---------------------------------------------------------------------------
// OAuth mode: browser-based install flow
// ---------------------------------------------------------------------------

let SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
let OAUTH_REDIRECT_URI = "https://tsortwehttam.github.io/msgmon/oauth"

export let BOT_SCOPE_LIST = [
  "channels:history",
  "channels:join",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "mpim:history",
  "users:read",
  "chat:write",
]
export let BOT_SCOPES = BOT_SCOPE_LIST.join(",")

export let USER_SCOPE_LIST = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "mpim:history",
  "users:read",
  "search:read",
  "chat:write",
]
export let USER_SCOPES = USER_SCOPE_LIST.join(",")

let openBrowser = (url: string) => {
  let cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open"
  exec(`${cmd} ${JSON.stringify(url)}`, () => {})
}

let parseCode = (input: string): string | null => {
  input = input.trim()
  // Accept a bare code
  if (/^\d+\.\d+\.\w+$/.test(input)) return input
  // Accept a full URL containing ?code=...
  try {
    let url = new URL(input)
    return url.searchParams.get("code")
  } catch {}
  return null
}

let authOAuth = async (account: string, verbose = false, externalRl?: readline.Interface) => {
  let credentialsPath = resolveCredentialsPath("slack")
  verboseLog(verbose, "reading credentials", { credentialsPath })

  let creds = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
  let clientId = creds.client_id
  let clientSecret = creds.client_secret
  if (!clientId || !clientSecret) {
    throw new Error(
      `${credentialsPath} must contain "client_id" and "client_secret".\n` +
      `Expected format: { "client_id": "...", "client_secret": "..." }\n` +
      `Find these under "Basic Information" in your Slack app settings.`
    )
  }

  let state = crypto.randomBytes(16).toString("hex")

  let authUrl =
    `${SLACK_OAUTH_AUTHORIZE_URL}?client_id=${clientId}&scope=${BOT_SCOPES}` +
    `&user_scope=${USER_SCOPES}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
    `&state=${state}`

  let ownRl = !externalRl
  let rl = externalRl ?? readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(`Add this Redirect URL to your Slack app (OAuth & Permissions > Redirect URLs):`)
  console.log(OAUTH_REDIRECT_URI)
  await rl.question("Press Enter when done...")

  openBrowser(authUrl)
  console.log("Opening browser... if it didn't open, visit:")
  console.log(authUrl)
  console.log("After authorizing, you'll see a page with a code. Paste it here.")

  let input = await rl.question("Paste URL or code: ")
  if (ownRl) rl.close()

  let code = parseCode(input)
  if (!code) throw new Error("Could not find an authorization code in that input. Try again.")

  // Verify state if present in the pasted URL
  try {
    let url = new URL(input.trim())
    let receivedState = url.searchParams.get("state")
    if (receivedState && receivedState !== state) {
      throw new Error("OAuth state mismatch — possible CSRF attack")
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("state mismatch")) throw e
  }

  // Exchange code for tokens
  let client = new WebClient()
  let oauthResponse = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
  })

  if (!oauthResponse.ok) {
    throw new Error(`oauth.v2.access failed: ${oauthResponse.error}`)
  }

  let botToken = oauthResponse.access_token
  let userToken = (oauthResponse.authed_user as { access_token?: string } | undefined)?.access_token
  let teamId = (oauthResponse.team as { id?: string } | undefined)?.id
  let teamName = (oauthResponse.team as { name?: string } | undefined)?.name

  if (!botToken) throw new Error("No bot token received from OAuth exchange")

  let tokenFile: SlackTokenFile = {
    bot_token: botToken,
    user_token: userToken,
    team_id: teamId,
    team_name: teamName,
  }

  let tokenDir = resolveTokenWriteDir("slack")
  let tokenPath = resolveTokenWritePathForAccount(account, "slack")
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.writeFileSync(tokenPath, JSON.stringify(tokenFile, null, 2) + "\n")

  verboseLog(verbose, "saved OAuth tokens", {
    account,
    tokenPath,
    teamId,
    hasUserToken: !!userToken,
  })
  console.log(`Authenticated workspace "${teamName}" (${teamId})`)
  console.log(`Bot token: yes | User token: ${userToken ? "yes" : "no"}`)
  console.log(`Saved ${tokenPath}`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export let configureAuthCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .option("account", {
      type: "string",
      default: DEFAULT_ACCOUNT,
      describe: "Account name (writes .msgmon/slack/tokens/<account>.json)",
    })
    .option("mode", {
      type: "string",
      choices: ["bot", "oauth"] as const,
      default: "bot",
      describe: "Auth mode: bot (paste token) or oauth (browser flow)",
    })
    .option("token", {
      type: "string",
      describe: "Bot token string (for --mode=bot; reads from stdin if omitted)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .example("$0 --token=xoxb-...", "Save a bot token for the default account")
    .example("$0 --mode=oauth --account=myworkspace", "Run OAuth install flow")
    .strict()
    .help()

export let parseAuthCli = async (args: string[], scriptName = "slack auth", rl?: readline.Interface) => {
  let argv = await configureAuthCli(yargs(args).scriptName(scriptName)).parseAsync()

  if (argv.mode === "oauth") {
    await authOAuth(argv.account, argv.verbose, rl)
  } else {
    let token = argv.token
    if (!token) {
      // Read from stdin
      let chunks: Buffer[] = []
      for await (let chunk of process.stdin) chunks.push(chunk as Buffer)
      token = Buffer.concat(chunks).toString("utf8").trim()
    }
    if (!token) throw new Error("No token provided. Pass --token or pipe to stdin.")
    await authBot(argv.account, token, argv.verbose)
  }
}

export let runAuthCli = (args = hideBin(process.argv), scriptName = "slack auth") =>
  parseAuthCli(args, scriptName).catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runAuthCli()
}

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { TOKEN_FILE_EXTENSION, resolveAllTokenDirs } from "../src/CliConfig"
import type { Argv } from "yargs"
import { verboseLog } from "../src/Verbose"

let listAccounts = () => {
  let all = new Set<string>()
  let dirs = resolveAllTokenDirs()
  for (let dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(TOKEN_FILE_EXTENSION)) continue
      all.add(path.basename(entry.name, TOKEN_FILE_EXTENSION))
    }
  }
  return { accounts: Array.from(all).sort((a, b) => a.localeCompare(b)), dirs }
}

export let configureAccountsCli = (cli: Argv) =>
  cli
    .usage("Usage: $0 [options]")
    .option("format", {
      type: "string",
      choices: ["json", "text"] as const,
      default: "json",
      describe: "Output format",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print diagnostic details to stderr",
    })
    .example("$0 --format=json", "Print account names as JSON array")
    .example("$0 --format=text", "Print one account per line")
    .epilog(
      [
        "Output contract:",
        "- json: array of account names derived from `./.mailmon/tokens/*.json`, `<mailmon-install-dir>/.mailmon/tokens/*.json`, and `~/.mailmon/tokens/*.json`.",
        "- text: one account name per line.",
      ].join("\n"),
    )
    .strict()
    .help()

export let parseAccountsCli = (args: string[], scriptName = "accounts") =>
  configureAccountsCli(yargs(args).scriptName(scriptName))
    .parseAsync()
    .then(argv => {
      let { accounts, dirs } = listAccounts()
      verboseLog(argv.verbose, "scanned token directories", dirs)
      verboseLog(argv.verbose, "accounts found", { count: accounts.length })
      if (argv.format === "text") {
        for (let account of accounts) console.log(account)
        return
      }
      console.log(JSON.stringify(accounts, null, 2))
    })

export let runAccountsCli = (args = hideBin(process.argv), scriptName = "accounts") =>
  parseAccountsCli(args, scriptName).catch(e => {
    console.error(e?.message ?? e)
    process.exit(1)
  })

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runAccountsCli()
}

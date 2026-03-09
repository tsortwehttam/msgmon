#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

let here = path.dirname(fileURLToPath(import.meta.url))
let root = path.resolve(here, "..")
let tsxCli = path.resolve(root, "node_modules", "tsx", "dist", "cli.mjs")
let cliEntry = path.resolve(root, "cli", "index.ts")

let child = spawn(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("exit", code => process.exit(code ?? 1))
child.on("error", err => {
  console.error(err?.message ?? err)
  process.exit(1)
})

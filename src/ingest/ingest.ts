import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import type { UnifiedMessage } from "../types"
import type { Sink } from "./sinks"
import { verboseLog } from "../Verbose"

// ---------------------------------------------------------------------------
// State — tracks which message IDs have been processed
// ---------------------------------------------------------------------------

export type IngestState = {
  ingested: Record<string, string>
}

export let readIngestState = (statePath: string): IngestState => {
  if (!fs.existsSync(statePath)) return { ingested: {} }
  try {
    let data = JSON.parse(fs.readFileSync(statePath, "utf8"))
    if (!data || typeof data !== "object" || typeof data.ingested !== "object") return { ingested: {} }
    return { ingested: data.ingested }
  } catch {
    return { ingested: {} }
  }
}

export let writeIngestState = (statePath: string, state: IngestState) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n")
}

export let buildDefaultStatePath = (params: { accounts: string[]; query: string }) => {
  let key = JSON.stringify({ accounts: params.accounts.sort(), query: params.query })
  let digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
  return path.resolve(process.cwd(), ".msgmon", "state", `ingest-${digest}.json`)
}

// ---------------------------------------------------------------------------
// Message source — platform adapters implement this
// ---------------------------------------------------------------------------

export type MessageSource = {
  /** Yields new messages matching the query for a given account */
  listMessages(params: {
    account: string
    query: string
    maxResults: number
    oldest?: string
    latest?: string
    verbose: boolean
  }): AsyncGenerator<UnifiedMessage>
}

// ---------------------------------------------------------------------------
// Ingest — the core loop
// ---------------------------------------------------------------------------

export type IngestParams = {
  sources: Array<{ source: MessageSource; accounts: string[]; query?: string; oldest?: string; latest?: string }>
  query: string
  maxResults: number
  sink: Sink
  statePath: string
  markRead?: (msg: UnifiedMessage, account: string) => Promise<void>
  doMarkRead: boolean
  seed: boolean
  verbose: boolean
}

/**
 * Single-pass ingest: scan all accounts, emit new messages to sink, update state.
 * Returns the count of newly ingested messages.
 */
export let ingestOnce = async (params: IngestParams): Promise<{ ingested: number; scanned: number; errors: string[] }> => {
  let state = readIngestState(params.statePath)
  let ingested = 0
  let scanned = 0
  let errors: string[] = []

  for (let { source, accounts, query, oldest, latest } of params.sources) {
    for (let account of accounts) {
      let effectiveQuery = query ?? params.query
      verboseLog(params.verbose, "ingest scanning", { account, query: effectiveQuery, oldest, latest })
      try {
        for await (let msg of source.listMessages({
          account,
          query: effectiveQuery,
          maxResults: params.maxResults,
          oldest,
          latest,
          verbose: params.verbose,
        })) {
          scanned += 1
          if (state.ingested[msg.id]) continue

          if (!params.seed) {
            await params.sink.write(msg)

            if (params.doMarkRead && params.markRead) {
              await params.markRead(msg, account)
            }
          }

          state.ingested[msg.id] = new Date().toISOString()
          writeIngestState(params.statePath, state)
          ingested += 1
        }
      } catch (err) {
        let orig = err instanceof Error ? err.message : String(err)
        errors.push(`[account: ${account}] ${orig}`)
      }
    }
  }

  return { ingested, scanned, errors }
}

/**
 * Continuous watch: repeatedly calls ingestOnce at the given interval.
 * Runs until the process is killed.
 */
export let watch = async (params: IngestParams & { intervalMs: number }) => {
  let sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let result = await ingestOnce(params)
    verboseLog(params.verbose, "watch cycle", result)
    await sleep(params.intervalMs)
  }
}

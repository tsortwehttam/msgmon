import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { workspaceDraftsRoot } from "../workspace/store"
import { Draft } from "./schema"

let draftsDir = (workspaceId: string) => {
  let dir = path.resolve(workspaceDraftsRoot(workspaceId))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export let generateDraftId = () => crypto.randomUUID()

export let draftFileName = (draft: Pick<Draft, "id" | "createdAt">) => {
  let stamp = draft.createdAt.replace(/[:.]/g, "-")
  return `${stamp}_${draft.id}.json`
}

export let saveDraft = (workspaceId: string, draft: Draft) => {
  let dir = draftsDir(workspaceId)
  for (let file of fs.readdirSync(dir)) {
    if (file.endsWith(`_${draft.id}.json`)) fs.unlinkSync(path.resolve(dir, file))
  }
  let filePath = path.resolve(dir, draftFileName(draft))
  fs.writeFileSync(filePath, JSON.stringify(draft, null, 2) + "\n")
  return filePath
}

export let loadDraft = (workspaceId: string, id: string): Draft => {
  let dir = draftsDir(workspaceId)
  let fileName = fs.readdirSync(dir).find(file => file.endsWith(`_${id}.json`))
  let filePath = fileName ? path.resolve(dir, fileName) : path.resolve(dir, `${id}.json`)
  if (!fs.existsSync(filePath)) throw new Error(`Draft "${id}" not found in workspace "${workspaceId}"`)
  let raw = JSON.parse(fs.readFileSync(filePath, "utf8"))
  return Draft.parse(raw)
}

export let listDrafts = (workspaceId: string, platform?: string): Draft[] => {
  let dir = draftsDir(workspaceId)
  if (!fs.existsSync(dir)) return []
  let files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()
  let drafts: Draft[] = []
  for (let file of files) {
    try {
      let raw = JSON.parse(fs.readFileSync(path.resolve(dir, file), "utf8"))
      let draft = Draft.parse(raw)
      if (platform && draft.platform !== platform) continue
      drafts.push(draft)
    } catch {
      // skip malformed files
    }
  }
  return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export let deleteDraft = (workspaceId: string, id: string) => {
  let dir = draftsDir(workspaceId)
  let fileName = fs.readdirSync(dir).find(file => file.endsWith(`_${id}.json`))
  let filePath = fileName ? path.resolve(dir, fileName) : path.resolve(dir, `${id}.json`)
  if (!fs.existsSync(filePath)) throw new Error(`Draft "${id}" not found in workspace "${workspaceId}"`)
  fs.unlinkSync(filePath)
}

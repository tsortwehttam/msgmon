export let verboseLog = (enabled: boolean | undefined, ...parts: unknown[]) => {
  if (!enabled) return
  console.error("[mailmon]", ...parts)
}

/**
 * Repair budget shared by gate auto-repair and the staged review loop.
 *
 * One setting (`executor.maxRepairRounds`) is read in several modules; keeping the default and the cap here means a
 * run cannot be bounded by 1 in one path and 2 in another while live.json validates up to 6.
 */
export const REPAIR_LIMIT = 6
export const REPAIR_DEFAULT = 2

/** Configured repair rounds: 0..REPAIR_LIMIT, default REPAIR_DEFAULT when unset or not a finite number. */
export function repairBudgetOf(config) {
  const value = config?.executor?.maxRepairRounds
  if (!Number.isFinite(value)) return REPAIR_DEFAULT
  return Math.max(0, Math.min(REPAIR_LIMIT, Math.floor(value)))
}

/**
 * Per-project deploy coalescing.
 *
 * At most one deployment may be "active" (queued | building | deploying |
 * reconciling) per project — enforced atomically by the
 * `uq_deployment_one_active_per_project` index. When a NEW trigger arrives
 * for a project that already holds the slot, a regular redeploy request
 * (manual, webhook, forceAll, refresh — anything except an atomic rollback
 * replay, which carries specific "restore exactly this" intent that must
 * never be merged into "redeploy whatever's current") coalesces here instead
 * of failing outright: any number of triggers that arrive while the slot is
 * held collapse into exactly ONE follow-up deploy, fired the moment the slot
 * frees, reflecting whatever is current at that moment — not a frozen
 * snapshot of intent from when any individual request came in.
 *
 * State is in-process only (not persisted) — this is a UX/reliability
 * improvement layered on top of the safety-critical fix (closing the
 * 'reconciling' gap in the unique index), not itself a correctness
 * guarantee. Losing a pending entry to an API restart just means one skipped
 * follow-up deploy, exactly as recoverable as a request that had arrived
 * while the API was down — the next manual click or webhook push picks it
 * back up.
 */

export interface PendingRedeploy {
  forceAll: boolean;
  /** `"all"` once forceAll or a set-mismatch escalates; `null` = "whatever
   *  the next organic trigger targets" (no explicit subset requested yet). */
  serviceIds: Set<string> | "all" | null;
  trigger: string;
}

const pending = new Map<string, PendingRedeploy>();

/**
 * Record (or merge into) a pending coalesced redeploy for `projectId`.
 * Merge rule: forceAll is OR'd; a mismatched service-id subset escalates to
 * "all" rather than guessing which services still matter by the time the
 * follow-up actually runs — under-deploying a coalesced request is exactly
 * the class of bug this module exists to prevent.
 */
export function requestCoalescedRedeploy(
  projectId: string,
  opts: { forceAll?: boolean; serviceIds?: string[]; trigger?: string },
): void {
  const existing = pending.get(projectId);
  const forceAll = !!opts.forceAll || !!existing?.forceAll;

  let serviceIds: Set<string> | "all" | null;
  if (forceAll) {
    serviceIds = "all";
  } else if (!opts.serviceIds || opts.serviceIds.length === 0) {
    serviceIds = existing?.serviceIds ?? null;
  } else if (!existing || existing.serviceIds === null) {
    serviceIds = new Set(opts.serviceIds);
  } else if (existing.serviceIds === "all") {
    serviceIds = "all";
  } else {
    serviceIds = new Set([...existing.serviceIds, ...opts.serviceIds]);
  }

  pending.set(projectId, {
    forceAll,
    serviceIds,
    // First trigger's provenance wins for logging/attribution purposes.
    trigger: existing?.trigger ?? opts.trigger ?? "manual",
  });
}

/** Pop and return the pending coalesced redeploy for `projectId`, if any. */
export function takeCoalescedRedeploy(projectId: string): PendingRedeploy | undefined {
  const entry = pending.get(projectId);
  if (entry) pending.delete(projectId);
  return entry;
}

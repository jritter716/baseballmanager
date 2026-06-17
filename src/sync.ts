import { GameEvent } from "./types";

/** An event with a stable global id (for idempotent sync) on top of the
 *  engine's ordering `seq`, plus the Clutch event-stream invariant (§3):
 *  org/team scope, a server timestamp, and the actor who recorded it. The
 *  engine/reducer ignores all of these — they exist for access control,
 *  auditing, and read projections. Optional so legacy/hand-built events and the
 *  pure reducer are unaffected; the server stamps them on every real append. */
export type EventEnvelope = GameEvent & {
  id: string;
  orgId?: string;        // the game's org
  teamId?: string;       // the team that owns this game's stream (home team)
  timestamp?: string;    // ISO time the server appended it (authoritative, like seq)
  actor?: string;        // PersonId who recorded it (set once auth is enforced)
};

/**
 * Offline-first sync model
 * ------------------------
 * The scorer's device holds the full local log and scores optimistically while
 * offline. Each event carries a stable `id` (generated on the device) so the
 * server can append idempotently. On reconnect the device:
 *   1. pulls remote events it hasn't seen,
 *   2. merges them in (remote is authoritative for ordering, by server `seq`),
 *   3. pushes its still-unsynced events.
 * The same reducer runs over the merged log on device and server, so the live
 * view a scorer sees offline matches the authoritative recompute once synced.
 */

/** Events present locally that the server hasn't acknowledged yet. */
export function pendingToPush(local: EventEnvelope[], remoteIds: Set<string>): EventEnvelope[] {
  return local.filter((e) => !remoteIds.has(e.id));
}

/**
 * Merge an authoritative remote log with the local log. Remote events keep
 * their server-assigned ordering; local-only (still-pending) events are placed
 * after, renumbered so optimistic local reduction stays correctly ordered until
 * the server assigns their real `seq` on push.
 */
export function mergeLogs(local: EventEnvelope[], remote: EventEnvelope[]): EventEnvelope[] {
  const remoteIds = new Set(remote.map((e) => e.id));
  const merged = [...remote].sort((a, b) => a.seq - b.seq);
  const maxSeq = merged.reduce((m, e) => Math.max(m, e.seq), 0);
  let next = maxSeq;
  for (const e of local) {
    if (!remoteIds.has(e.id)) merged.push({ ...e, seq: ++next } as EventEnvelope);
  }
  return merged;
}

/** Highest server seq the device has seen, for the next incremental pull. */
export function highWaterMark(log: EventEnvelope[]): number {
  return log.reduce((m, e) => Math.max(m, e.seq), 0);
}

/**
 * Client entrypoint — the browser/mobile-safe surface of the engine.
 *
 * This exports ONLY the pure, portable pieces: the reducer, projections
 * (stats / decisions), runner-movement defaults, validation, pitch-count
 * rules, lineup helpers, and the offline-sync primitives. They have no
 * runtime dependencies and no I/O, so this module is safe to bundle for a
 * `<script type="module">` web page, a PWA, or a React Native app.
 *
 * Deliberately NOT re-exported here:
 *   - `store.ts`  — authoritative server store (imports node:crypto)
 *   - `server.ts` — HTTP + SSE server (imports node:http)
 *   - `retrosheet.ts` — replay/test oracle, not app code
 * Those remain available from `./index` for Node (tests, the server).
 *
 * This is the single source of truth for engine logic consumed by the UI.
 * The web app imports the compiled bundle of THIS file rather than carrying
 * its own hand-written copy.
 */

export * from "./types";
export {
  initialState,
  apply,
  reduce,
  currentBatter,
  fieldingSide,
} from "./reducer";
export { validate, applyChecked, type Problem } from "./validate";
export { defaultRunnerMoves } from "./defaults";
export {
  editableRunners,
  toRunnerMoves,
  type RunnerEdit,
  type RunnerDest,
} from "./runners";
export {
  stats,
  type StatsResult,
  type BattingLine,
  type PitchingLine,
  type FieldingLine,
} from "./stats";
export {
  type LeagueRules,
  type RestTier,
  type Outing,
  type CountStatus,
  LITTLE_LEAGUE_MAJORS,
  restDaysRequired,
  nextRestBoundary,
  countStatus,
  pitcherStatus,
  isEligible,
} from "./pitching";
export {
  currentPitcher,
  playerAtPosition,
  applySubstitution,
  initLineupState,
} from "./lineup";
export { decisions, type Decisions } from "./decisions";
export {
  type EventEnvelope,
  mergeLogs,
  pendingToPush,
  highWaterMark,
} from "./sync";

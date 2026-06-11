// Runner-advancement override model.
//
// The scoring UI lets a scorer adjust where each runner ends up on a play
// instead of taking the engine defaults (e.g. a runner scores from first on a
// double, holds instead of advancing, is thrown out, or advances on an error).
// This module is the pure bridge between the engine's `defaultRunnerMoves` and
// the explicit `RunnerMove[]` the event carries: build an editable model
// pre-filled with defaults, let the UI tweak it, then serialize back to moves.
import { Base, PaOutcome, PlayerId, RunnerMove } from "./types";
import { defaultRunnerMoves } from "./defaults";

type Bases = Partial<Record<Base, PlayerId>>;
export type RunnerDest = Base | "home" | "out";

/** One mover (the batter or a runner already on base) the scorer can adjust. */
export interface RunnerEdit {
  id: PlayerId;
  /** Where the mover starts: a base, or "batter" for the hitter. */
  from: Base | "batter";
  /** Chosen destination (pre-filled from the engine default). */
  to: RunnerDest;
  /** Scorer flag: the move happened because of an error (drives earned runs). */
  onError: boolean;
  /** Valid destinations to offer, including holding at the origin base. */
  options: RunnerDest[];
}

/** Outcomes for which a run scored by the batter's hit earns an RBI. */
const RBI_OUTCOMES = new Set<PaOutcome>([
  "single", "double", "triple", "home_run", "sacrifice_fly",
]);

const occupied = (bases: Bases): Base[] =>
  ([1, 2, 3] as Base[]).filter((b) => bases[b] !== undefined);

/** Valid destinations for a mover, never moving backward; includes "hold". */
function optionsFor(from: Base | "batter"): RunnerDest[] {
  if (from === "batter") return [1, 2, 3, "home", "out"];
  const ahead = ([1, 2, 3] as Base[]).filter((b) => b > from);
  return [from, ...ahead, "home", "out"];
}

/**
 * Build the editable runner model for a play, pre-filled with engine defaults.
 * Includes the batter and every runner currently on base; runners the default
 * holds are shown holding at their base.
 */
export function editableRunners(
  outcome: PaOutcome,
  bases: Bases,
  batter: PlayerId
): RunnerEdit[] {
  const defaults = defaultRunnerMoves(outcome, bases, batter);
  const byFrom = new Map<Base | "batter", RunnerMove>();
  for (const m of defaults) byFrom.set(m.from, m);

  const movers: Array<{ id: PlayerId; from: Base | "batter" }> = [
    { id: batter, from: "batter" },
    ...occupied(bases).map((b) => ({ id: bases[b]!, from: b as Base })),
  ];

  return movers.map(({ id, from }) => {
    const def = byFrom.get(from);
    return {
      id,
      from,
      to: def ? def.to : (from as RunnerDest), // no default move => holds
      onError: !!def?.onError,
      options: optionsFor(from),
    };
  });
}

/**
 * Serialize edited movers back into explicit RunnerMove[]. Movers that hold at
 * their origin base are omitted (a no-op), so accepting every default yields a
 * move list equivalent to `defaultRunnerMoves`. Fielding (`outBy`) and RBI
 * credit from the matching default are preserved when a mover is unchanged;
 * a newly-scored runner on a hit is credited an RBI to the batter unless the
 * move is flagged as an error.
 */
export function toRunnerMoves(
  edits: RunnerEdit[],
  outcome: PaOutcome,
  batter: PlayerId,
  bases: Bases
): RunnerMove[] {
  const byFrom = new Map<Base | "batter", RunnerMove>();
  for (const m of defaultRunnerMoves(outcome, bases, batter)) byFrom.set(m.from, m);

  const moves: RunnerMove[] = [];
  for (const e of edits) {
    // A runner holding at its base is a no-op; leave the base untouched.
    if (e.from !== "batter" && e.to === e.from && !e.onError) continue;

    const def = byFrom.get(e.from);
    const move: RunnerMove = { id: e.id, from: e.from, to: e.to };

    if (e.to === "out" && def?.outBy) move.outBy = def.outBy;

    const unchanged = def && def.to === e.to;
    if (e.onError || (unchanged && def?.onError)) move.onError = true;

    if (e.to === "home" && !move.onError) {
      if (unchanged && def?.rbiTo) move.rbiTo = def.rbiTo;       // keep default RBI
      else if (RBI_OUTCOMES.has(outcome)) move.rbiTo = batter;   // new run on a hit
    }
    moves.push(move);
  }
  return moves;
}

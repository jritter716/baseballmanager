import { defaultRunnerMoves } from "./defaults";
import { Base, GameEvent, GameState, RunnerMove } from "./types";

export interface Problem {
  code: string;
  message: string;
}

/**
 * Check an event against current state and report any invariant violations.
 * Run this before apply() so scorer mistakes surface live rather than as
 * corrupted statistics later. Returns [] when the event is legal.
 */
export function validate(s: GameState, e: GameEvent): Problem[] {
  const problems: Problem[] = [];

  if (s.outs >= 3) {
    problems.push({
      code: "inning_over",
      message: "There are already 3 outs; the half-inning should have ended.",
    });
  }

  const moves: RunnerMove[] | undefined =
    e.type === "pa_result"
      ? e.runners ?? defaultRunnerMoves(e.outcome, s.bases, e.batter)
      : e.type === "baserunning"
      ? e.runners
      : undefined;

  if (moves) {
    let projectedOuts = s.outs;
    for (const m of moves) {
      if (m.from !== "batter") {
        const occupant = s.bases[m.from as Base];
        if (occupant === undefined) {
          problems.push({
            code: "empty_base",
            message: `No runner on base ${m.from} to move.`,
          });
        } else if (occupant !== m.id) {
          problems.push({
            code: "wrong_runner",
            message: `Base ${m.from} holds ${occupant}, not ${m.id}.`,
          });
        }
      }
      if (m.to === "out") projectedOuts++;
    }
    if (projectedOuts > 3) {
      problems.push({
        code: "too_many_outs",
        message: `Play records ${projectedOuts - s.outs} out(s) with ${s.outs} already recorded.`,
      });
    }
  }

  return problems;
}

/** Convenience: apply only if valid, otherwise throw with the first problem. */
export function applyChecked(
  s: GameState,
  e: GameEvent,
  apply: (s: GameState, e: GameEvent) => GameState
): GameState {
  const problems = validate(s, e);
  if (problems.length > 0) {
    throw new Error(`Invalid event (seq ${e.seq}): ${problems[0].message}`);
  }
  return apply(s, e);
}

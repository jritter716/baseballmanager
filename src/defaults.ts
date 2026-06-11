import { Base, PaOutcome, PlayerId, RunnerMove } from "./types";

type Bases = Partial<Record<Base, PlayerId>>;

function occupied(bases: Bases): Base[] {
  return ([3, 2, 1] as Base[]).filter((b) => bases[b] !== undefined);
}

/** Advance every existing runner by `n` bases; runners reaching home score. */
function advanceAll(bases: Bases, n: number, batter: PlayerId, batterTo: Base | "home"): RunnerMove[] {
  const moves: RunnerMove[] = [];
  for (const b of occupied(bases)) {
    const dest = b + n;
    if (dest >= 4) moves.push({ id: bases[b]!, from: b, to: "home", rbiTo: batter });
    else moves.push({ id: bases[b]!, from: b, to: dest as Base });
  }
  if (batterTo === "home") moves.push({ id: batter, from: "batter", to: "home", rbiTo: batter });
  else moves.push({ id: batter, from: "batter", to: batterTo });
  return moves;
}

/** Force-advance: the batter takes first; runners advance only when forced. */
function forceWalk(bases: Bases, batter: PlayerId): RunnerMove[] {
  const moves: RunnerMove[] = [{ id: batter, from: "batter", to: 1 }];
  if (bases[1] === undefined) return moves; // first open, nobody forced
  if (bases[2] === undefined) {
    moves.push({ id: bases[1]!, from: 1, to: 2 });
    return moves;
  }
  if (bases[3] === undefined) {
    moves.push({ id: bases[2]!, from: 2, to: 3 });
    moves.push({ id: bases[1]!, from: 1, to: 2 });
    return moves;
  }
  // bases loaded -> forced run
  moves.push({ id: bases[3]!, from: 3, to: "home", rbiTo: batter });
  moves.push({ id: bases[2]!, from: 2, to: 3 });
  moves.push({ id: bases[1]!, from: 1, to: 2 });
  return moves;
}

/**
 * Standard runner movements for an outcome given the current base state.
 * The scorer is expected to override these whenever a play is non-routine
 * (extra base taken, runner thrown out, etc.). These defaults keep the
 * common case to a single tap.
 */
export function defaultRunnerMoves(
  outcome: PaOutcome,
  bases: Bases,
  batter: PlayerId
): RunnerMove[] {
  switch (outcome) {
    case "single":
      return advanceAll(bases, 1, batter, 1);
    case "double":
      return advanceAll(bases, 2, batter, 2);
    case "triple":
      return advanceAll(bases, 3, batter, 3);
    case "home_run":
      return advanceAll(bases, 4, batter, "home");

    case "walk":
    case "intentional_walk":
    case "hit_by_pitch":
      return forceWalk(bases, batter);

    case "strikeout":
      return [{ id: batter, from: "batter", to: "out", outBy: ["C"] }];

    case "groundout":
    case "flyout":
    case "lineout":
    case "popout":
      // Batter is out; existing runners hold by default.
      return [{ id: batter, from: "batter", to: "out" }];

    case "sacrifice_fly": {
      const moves: RunnerMove[] = [{ id: batter, from: "batter", to: "out" }];
      if (bases[3] !== undefined)
        moves.push({ id: bases[3]!, from: 3, to: "home", rbiTo: batter });
      return moves;
    }

    case "sacrifice_bunt": {
      // Batter out; lead runners advance one base (not credited as RBI by rule
      // unless a run scores from third — handled by stats, RBI on a SH is rare).
      const moves: RunnerMove[] = [{ id: batter, from: "batter", to: "out" }];
      for (const b of occupied(bases)) {
        const dest = b + 1;
        if (dest >= 4) moves.push({ id: bases[b]!, from: b, to: "home" });
        else moves.push({ id: bases[b]!, from: b, to: dest as Base });
      }
      return moves;
    }

    case "fielders_choice": {
      // Batter safe at first; lead forced runner is retired.
      const moves: RunnerMove[] = [{ id: batter, from: "batter", to: 1 }];
      const lead = ([1, 2, 3] as Base[]).reverse().find((b) => bases[b] !== undefined);
      if (lead !== undefined)
        moves.push({ id: bases[lead]!, from: lead, to: "out", outBy: ["SS"] });
      return moves;
    }

    case "reached_on_error":
      // Batter reaches on an error; runners advance one base, no out recorded.
      return [
        { id: batter, from: "batter", to: 1, onError: true },
        ...occupied(bases).map((b): RunnerMove => {
          const dest = b + 1;
          return dest >= 4
            ? { id: bases[b]!, from: b, to: "home", onError: true }
            : { id: bases[b]!, from: b, to: dest as Base };
        }),
      ];

    case "double_play": {
      // Batter out plus the lead forced runner.
      const moves: RunnerMove[] = [
        { id: batter, from: "batter", to: "out", outBy: ["1B"] },
      ];
      const lead = ([1, 2, 3] as Base[]).find((b) => bases[b] !== undefined);
      if (lead !== undefined)
        moves.push({ id: bases[lead]!, from: lead, to: "out", outBy: ["SS", "2B"] });
      return moves;
    }

    case "triple_play": {
      const moves: RunnerMove[] = [
        { id: batter, from: "batter", to: "out" },
      ];
      const present = occupied(bases).slice(0, 2);
      for (const b of present) moves.push({ id: bases[b]!, from: b, to: "out" });
      return moves;
    }
  }
}

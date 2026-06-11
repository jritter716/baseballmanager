import { defaultRunnerMoves } from "./defaults";
import {
  applySubstitution,
  currentBatter,
  fieldingSide,
  initLineupState,
  pitcherOfLineup,
} from "./lineup";
import {
  Base,
  GameEvent,
  GameSetup,
  GameState,
  PaResultEvent,
  PitchEvent,
  BaserunningEvent,
  RunnerMove,
} from "./types";

export function initialState(setup: GameSetup): GameState {
  return {
    inning: 1,
    half: "top",
    outs: 0,
    count: { balls: 0, strikes: 0 },
    bases: {},
    score: { away: 0, home: 0 },
    battingTeam: "away",
    order: { away: 0, home: 0 },
    pitcher: {
      away: pitcherOfLineup(setup.away.battingOrder),
      home: pitcherOfLineup(setup.home.battingOrder),
    },
    pitchCount: {},
    lineup: initLineupState(setup),
  };
}

function clone(s: GameState): GameState {
  return {
    ...s,
    count: { ...s.count },
    bases: { ...s.bases },
    score: { ...s.score },
    order: { ...s.order },
    pitcher: { ...s.pitcher },
    pitchCount: { ...s.pitchCount },
    lineup: {
      away: s.lineup.away.map((x) => ({ ...x })),
      home: s.lineup.home.map((x) => ({ ...x })),
    },
  };
}

function endHalfInning(s: GameState): GameState {
  const next = clone(s);
  next.outs = 0;
  next.bases = {};
  next.count = { balls: 0, strikes: 0 };
  if (s.half === "top") {
    next.half = "bottom";
    next.battingTeam = "home";
  } else {
    next.half = "top";
    next.battingTeam = "away";
    next.inning = s.inning + 1;
  }
  return next;
}

function advanceBatter(s: GameState): GameState {
  const next = clone(s);
  const side = s.battingTeam;
  next.order[side] = (s.order[side] + 1) % s.lineup[side].length;
  return next;
}

// --- event handlers --------------------------------------------------------

function applyPitch(s: GameState, e: PitchEvent): GameState {
  const next = clone(s);
  next.pitchCount[e.pitcher] = (next.pitchCount[e.pitcher] ?? 0) + 1;
  let { balls, strikes } = next.count;
  switch (e.result) {
    case "ball":
      balls++;
      break;
    case "called_strike":
    case "swinging_strike":
    case "foul_tip":
      strikes++;
      break;
    case "foul":
      strikes = Math.min(strikes + 1, 2); // a foul never makes strike three
      break;
    case "in_play":
    case "hit_by_pitch":
      break; // pitch counted; PA resolved by the following pa_result
  }
  next.count = { balls, strikes };
  return next;
}

function applyRunnerMoves(s: GameState, moves: RunnerMove[]): GameState {
  const next = clone(s);
  // Pass 1: vacate every origin base (read against the original occupancy)
  // so a runner being forced ahead frees the base before the batter fills it.
  for (const m of moves) {
    if (m.from !== "batter") delete next.bases[m.from as Base];
  }
  // Pass 2: place destinations, tally runs and outs.
  let runs = 0;
  for (const m of moves) {
    if (m.to === "home") runs++;
    else if (m.to === "out") next.outs++;
    else next.bases[m.to as Base] = m.id;
  }
  next.score[s.battingTeam] += runs;
  return next;
}

function applyPaResult(s: GameState, e: PaResultEvent): GameState {
  const batter = e.batter;
  const moves = e.runners ?? defaultRunnerMoves(e.outcome, s.bases, batter);
  let next = applyRunnerMoves(s, moves);
  next.count = { balls: 0, strikes: 0 };
  next = advanceBatter(next);
  if (next.outs >= 3) next = endHalfInning(next);
  return next;
}

function applyBaserunning(s: GameState, e: BaserunningEvent): GameState {
  let next = applyRunnerMoves(s, e.runners);
  if (next.outs >= 3) next = endHalfInning(next);
  return next;
}

function applySub(s: GameState, e: GameEvent & { type: "substitution" }): GameState {
  let next = clone(s);
  next.lineup = applySubstitution(next.lineup, e);
  if (e.kind === "pitching" || e.position === "P") {
    next.pitcher[e.team] = e.playerIn;
  }
  return next;
}

// --- the reducer -----------------------------------------------------------

export function apply(s: GameState, e: GameEvent): GameState {
  switch (e.type) {
    case "pitch":
      return applyPitch(s, e);
    case "pa_result":
      return applyPaResult(s, e);
    case "baserunning":
      return applyBaserunning(s, e);
    case "substitution":
      return applySub(s, e);
  }
}

/** Fold the entire (ordered) event log into final game state. Pure + deterministic. */
export function reduce(setup: GameSetup, events: GameEvent[]): GameState {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .reduce(apply, initialState(setup));
}

export { currentBatter, fieldingSide };

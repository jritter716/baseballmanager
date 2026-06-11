import {
  applySubstitution,
  initLineupState,
  pitcherOfLineup,
  playerAtPosition,
} from "./lineup";
import { defaultRunnerMoves } from "./defaults";
import {
  Base,
  GameEvent,
  GameSetup,
  LineupState,
  PaResultEvent,
  PlayerId,
  Position,
  RunnerMove,
  TeamSide,
} from "./types";

export interface BattingLine {
  pa: number;
  ab: number;
  r: number;
  h: number;
  doubles: number;
  triples: number;
  hr: number;
  rbi: number;
  bb: number;
  hbp: number;
  so: number;
  sf: number;
  sh: number;
  tb: number;
  avg: number;
  obp: number;
  slg: number;
  ops: number;
}

export interface PitchingLine {
  bf: number;
  outs: number;
  h: number;
  r: number;
  er: number;
  bb: number;
  hbp: number;
  so: number;
  pitches: number;
  ip: string; // "X.Y" baseball notation
  era: number;
  whip: number;
}

export interface FieldingLine {
  po: number;
  a: number;
  e: number;
}

export interface StatsResult {
  batting: Record<PlayerId, BattingLine>;
  pitching: Record<PlayerId, PitchingLine>;
  fielding: Record<PlayerId, FieldingLine>;
}

function emptyBatting(): BattingLine {
  return {
    pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0,
    bb: 0, hbp: 0, so: 0, sf: 0, sh: 0, tb: 0,
    avg: 0, obp: 0, slg: 0, ops: 0,
  };
}
function emptyPitching(): PitchingLine {
  return {
    bf: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, hbp: 0, so: 0, pitches: 0,
    ip: "0.0", era: 0, whip: 0,
  };
}
function emptyFielding(): FieldingLine {
  return { po: 0, a: 0, e: 0 };
}

const NON_AB = new Set([
  "walk", "intentional_walk", "hit_by_pitch", "sacrifice_fly", "sacrifice_bunt",
]);
const HITS = new Set(["single", "double", "triple", "home_run"]);

/**
 * Fold the event log into batting / pitching / fielding lines.
 *
 * Earned-run model (documented simplification): a run is charged as EARNED to
 * the pitcher who put the scoring runner on base, unless (a) that runner reached
 * on an error, (b) the scoring move was flagged onError, or (c) the inning's
 * "reconstructed" out total (real outs + phantom outs from errors) had already
 * reached three. Phantom outs accrue from `reached_on_error` and from any move
 * flagged `wouldHaveBeenOut`. Multi-error innings can require official-scorer
 * judgment this approximation does not fully capture.
 */
export function stats(setup: GameSetup, events: GameEvent[]): StatsResult {
  const batting: Record<PlayerId, BattingLine> = {};
  const pitching: Record<PlayerId, PitchingLine> = {};
  const fielding: Record<PlayerId, FieldingLine> = {};

  const bat = (id: PlayerId) => (batting[id] ??= emptyBatting());
  const pit = (id: PlayerId) => (pitching[id] ??= emptyPitching());
  const fld = (id: PlayerId) => (fielding[id] ??= emptyFielding());

  let lineup: LineupState = initLineupState(setup);
  let battingSide: TeamSide = "away";
  const pitcherOf: Record<TeamSide, PlayerId> = {
    away: pitcherOfLineup(setup.away.battingOrder),
    home: pitcherOfLineup(setup.home.battingOrder),
  };

  // Per-inning reconstruction + base occupancy responsibility.
  let realOuts = 0;
  let phantomOuts = 0;
  let bases: Partial<Record<Base, PlayerId>> = {};
  const onBase = new Map<PlayerId, { pitcher: PlayerId; onError: boolean }>();

  const fieldingSideNow = (): TeamSide => (battingSide === "away" ? "home" : "away");

  function resetInning() {
    realOuts = 0;
    phantomOuts = 0;
    bases = {};
    onBase.clear();
    battingSide = fieldingSideNow();
  }

  function creditFielding(positions: Position[] | undefined) {
    if (!positions || positions.length === 0) return;
    const side = fieldingSideNow();
    positions.forEach((pos, i) => {
      const pid = playerAtPosition(lineup, side, pos);
      if (!pid) return;
      if (i === positions.length - 1) fld(pid).po++;
      else fld(pid).a++;
    });
  }

  function processMoves(
    moves: RunnerMove[],
    pitcher: PlayerId,
    batterFielders: Position[] | undefined,
    batterReachedOnError: boolean
  ) {
    // Pass 1: vacate origins so a forced advance frees the base before a fill.
    for (const m of moves) {
      if (m.from !== "batter") delete bases[m.from as Base];
    }
    for (const m of moves) {
      if (m.to === "home") {
        // Run scores.
        bat(m.id).r++;
        const owner = onBase.get(m.id);
        const respPitcher = owner ? owner.pitcher : pitcher;
        pit(respPitcher).r++;
        const reconstructedOuts = realOuts + phantomOuts;
        const earned =
          !(owner?.onError) && !m.onError && reconstructedOuts < 3;
        if (earned) pit(respPitcher).er++;
        if (m.rbiTo && !m.onError) bat(m.rbiTo).rbi++;
        onBase.delete(m.id);
      } else if (m.to === "out") {
        realOuts++;
        pit(pitcher).outs++;
        const seq =
          m.outBy ?? (m.from === "batter" ? batterFielders : undefined);
        creditFielding(seq);
        if (m.from !== "batter") onBase.delete(m.id);
        if (m.wouldHaveBeenOut) phantomOuts++;
      } else {
        // Advance to a base (or batter reaches).
        const dest = m.to as Base;
        bases[dest] = m.id;
        if (m.from === "batter") {
          onBase.set(m.id, {
            pitcher,
            onError: batterReachedOnError || !!m.onError,
          });
        }
        if (m.wouldHaveBeenOut) phantomOuts++;
      }
    }
  }

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type === "pitch") {
      pit(e.pitcher).pitches++;
      continue;
    }

    if (e.type === "substitution") {
      lineup = applySubstitution(lineup, e);
      if (e.kind === "pitching" || e.position === "P") {
        pitcherOf[e.team] = e.playerIn;
      }
      continue;
    }

    if (e.type === "baserunning") {
      const pitcher = e.pitcher ?? pitcherOf[fieldingSideNow()];
      for (const pos of e.errors ?? []) {
        const pid = playerAtPosition(lineup, fieldingSideNow(), pos);
        if (pid) fld(pid).e++;
      }
      processMoves(e.runners, pitcher, undefined, false);
      if (realOuts >= 3) resetInning();
      continue;
    }

    // pa_result
    const pa = e as PaResultEvent;
    const b = bat(pa.batter);
    const p = pit(pa.pitcher);
    b.pa++;
    p.bf++;

    if (!NON_AB.has(pa.outcome)) b.ab++;

    if (HITS.has(pa.outcome)) {
      b.h++;
      p.h++;
      if (pa.outcome === "single") b.tb += 1;
      else if (pa.outcome === "double") { b.doubles++; b.tb += 2; }
      else if (pa.outcome === "triple") { b.triples++; b.tb += 3; }
      else { b.hr++; b.tb += 4; }
    } else if (pa.outcome === "walk" || pa.outcome === "intentional_walk") {
      b.bb++; p.bb++;
    } else if (pa.outcome === "hit_by_pitch") {
      b.hbp++; p.hbp++;
    } else if (pa.outcome === "strikeout") {
      b.so++; p.so++;
    } else if (pa.outcome === "sacrifice_fly") {
      b.sf++;
    } else if (pa.outcome === "sacrifice_bunt") {
      b.sh++;
    }

    for (const pos of pa.errors ?? []) {
      const pid = playerAtPosition(lineup, fieldingSideNow(), pos);
      if (pid) fld(pid).e++;
    }

    const reachedOnError = pa.outcome === "reached_on_error";
    if (reachedOnError) phantomOuts++; // batter would have been out

    const moves = pa.runners ?? defaultRunnerMoves(pa.outcome, bases, pa.batter);
    processMoves(moves, pa.pitcher, pa.fielders, reachedOnError);

    if (realOuts >= 3) resetInning();
  }

  finalize(batting, pitching);
  return { batting, pitching, fielding };
}

function finalize(
  batting: Record<PlayerId, BattingLine>,
  pitching: Record<PlayerId, PitchingLine>
) {
  for (const line of Object.values(batting)) {
    const obDen = line.ab + line.bb + line.hbp + line.sf;
    line.avg = line.ab ? line.h / line.ab : 0;
    line.obp = obDen ? (line.h + line.bb + line.hbp) / obDen : 0;
    line.slg = line.ab ? line.tb / line.ab : 0;
    line.ops = line.obp + line.slg;
  }
  for (const line of Object.values(pitching)) {
    const inn = line.outs / 3;
    line.ip = `${Math.floor(line.outs / 3)}.${line.outs % 3}`;
    line.era = inn ? (line.er * 9) / inn : 0;
    line.whip = inn ? (line.bb + line.h) / inn : 0;
  }
}

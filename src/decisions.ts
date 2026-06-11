import { apply, initialState, fieldingSide } from "./reducer";
import { defaultRunnerMoves } from "./defaults";
import { GameEvent, GameSetup, PlayerId, RunnerMove, TeamSide } from "./types";

export interface Decisions {
  winner: TeamSide | null;
  win: PlayerId | null;
  loss: PlayerId | null;
  save: PlayerId | null;
  notes: string[];
}

interface RunRec {
  scoringSide: TeamSide;
  after: { away: number; home: number };
  winnerCand: PlayerId; // scoring team's pitcher of record at this run
  responsible: PlayerId; // defending pitcher charged with the run
}

interface Entry {
  team: TeamSide;
  isStarter: boolean;
  lead: number; // entering team's lead at entry (their score - opponent's)
  runnersOn: number;
  inning: number;
}

/**
 * Attribute the win, loss and save per the official rules.
 *
 * Deterministic core, with two documented judgment gaps that real official
 * scorers resolve by discretion:
 *  - If the winning team's STARTER is the pitcher of record at the go-ahead but
 *    failed to pitch the required minimum (5 innings in a 6+ inning game), the
 *    win is reassigned. We pick the winning team's most-used reliever as the
 *    "most effective" stand-in; a human scorer may choose differently.
 *  - The save's "3 effective innings" and "tying run on deck" clauses are
 *    approximated. The lead-of-3-or-fewer + 1 inning clause is exact.
 */
export function decisions(setup: GameSetup, events: GameEvent[]): Decisions {
  let s = initialState(setup);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const notes: string[] = [];

  const starters = { away: s.pitcher.away, home: s.pitcher.home };
  const pitcherOuts: Record<PlayerId, number> = {};
  const entry: Record<PlayerId, Entry> = {
    [starters.away]: { team: "away", isStarter: true, lead: 0, runnersOn: 0, inning: 1 },
    [starters.home]: { team: "home", isStarter: true, lead: 0, runnersOn: 0, inning: 1 },
  };
  const usedBy: Record<TeamSide, Set<PlayerId>> = {
    away: new Set([starters.away]),
    home: new Set([starters.home]),
  };
  const onBase = new Map<PlayerId, PlayerId>(); // runner -> responsible pitcher
  const runs: RunRec[] = [];

  for (const e of sorted) {
    if (e.type === "substitution") {
      if (e.kind === "pitching" || e.position === "P") {
        const side = e.team;
        const opp: TeamSide = side === "away" ? "home" : "away";
        entry[e.playerIn] = {
          team: side,
          isStarter: false,
          lead: s.score[side] - s.score[opp],
          runnersOn: Object.keys(s.bases).length,
          inning: s.inning,
        };
        usedBy[side].add(e.playerIn);
      }
      s = apply(s, e);
      continue;
    }
    if (e.type === "pitch") { s = apply(s, e); continue; }

    const battingTeam = s.battingTeam;
    const defPitcher = s.pitcher[fieldingSide(battingTeam)];
    const moves: RunnerMove[] =
      e.type === "pa_result"
        ? e.runners ?? defaultRunnerMoves(e.outcome, s.bases, e.batter)
        : e.runners;

    const after = { ...s.score };
    for (const m of moves) {
      if (m.to === "home") {
        const responsible = onBase.get(m.id) ?? defPitcher;
        after[battingTeam]++;
        runs.push({ scoringSide: battingTeam, after: { ...after }, winnerCand: s.pitcher[battingTeam], responsible });
        onBase.delete(m.id);
      } else if (m.to === "out") {
        pitcherOuts[defPitcher] = (pitcherOuts[defPitcher] ?? 0) + 1;
        if (m.from !== "batter") onBase.delete(m.id);
      } else if (m.from === "batter") {
        onBase.set(m.id, defPitcher);
      }
    }
    s = apply(s, e);
  }

  const winner: TeamSide | null =
    s.score.away > s.score.home ? "away" : s.score.home > s.score.away ? "home" : null;
  if (!winner) return { winner: null, win: null, loss: null, save: null, notes: ["Game tied — no decisions."] };
  const loserSide: TeamSide = winner === "away" ? "home" : "away";

  // permanent go-ahead: scan back to the run from which the winner stays ahead
  let goAheadIdx = -1;
  for (let i = runs.length - 1; i >= 0; i--) {
    const a = runs[i].after;
    if (a[winner] > a[loserSide]) goAheadIdx = i;
    else break;
  }
  if (goAheadIdx < 0) return { winner, win: null, loss: null, save: null, notes: ["Could not locate go-ahead run."] };

  let win: PlayerId | null = runs[goAheadIdx].winnerCand;
  const loss: PlayerId | null = runs[goAheadIdx].responsible;

  // starter-minimum rule for the winning pitcher
  const finalInning = s.inning;
  const required = finalInning >= 6 ? 15 : finalInning >= 5 ? 12 : 9;
  const completeGame = usedBy[winner].size === 1;
  if (!completeGame && entry[win]?.isStarter && (pitcherOuts[win] ?? 0) < required) {
    const relievers = [...usedBy[winner]].filter((p) => !entry[p]?.isStarter);
    relievers.sort((a, b) => (pitcherOuts[b] ?? 0) - (pitcherOuts[a] ?? 0));
    if (relievers.length) {
      notes.push(`Win reassigned from starter (under ${required / 3} IP) to most-used reliever — a scorer judgment call.`);
      win = relievers[0];
    }
  }

  // save: the finishing pitcher of the winning team, if not the winner
  let save: PlayerId | null = null;
  const finisher = s.pitcher[winner];
  if (finisher !== win) {
    const en = entry[finisher];
    const outs = pitcherOuts[finisher] ?? 0;
    if (en && en.lead >= 1) {
      const leadOf3 = en.lead <= 3 && outs >= 3;
      const threeInnings = outs >= 9;
      const tyingClose = en.lead - en.runnersOn <= 1; // tying run on base / close
      if (leadOf3 || threeInnings || tyingClose) save = finisher;
      if (threeInnings && !leadOf3) notes.push("Save via 3-inning clause (approximate).");
    }
  }

  return { winner, win, loss, save, notes };
}

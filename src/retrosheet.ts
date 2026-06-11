import {
  Base,
  GameEvent,
  GameSetup,
  LineupSlot,
  PaOutcome,
  Position,
  RunnerMove,
  TeamSide,
} from "./types";
import { reduce } from "./reducer";
import { stats, StatsResult } from "./stats";

// ---------------------------------------------------------------------------
// Retrosheet event files
// ---------------------------------------------------------------------------
//
// Reference: https://www.retrosheet.org/eventfile.htm
//
// A game is a sequence of comma-separated records. The ones we consume:
//   id,<gameid>
//   info,<key>,<value>
//   start,<playerid>,"<name>",<team 0|1>,<batting order>,<field position>
//   sub,<playerid>,"<name>",<team 0|1>,<batting order>,<field position>
//   play,<inning>,<team 0|1>,<batterid>,<count>,<pitches>,<event>
//   data,er,<pitcherid>,<earned runs>
//
// `team` is 0 for the visiting (away) side, 1 for the home side.
//
// The `event` field is the hard part — a compact play grammar:
//   BASIC/MOD/MOD.ADV;ADV
// e.g.  S8            single to center
//       D7/L.2-H      line-drive double, runner on 2 scores
//       64(1)3/GDP    ground into double play (runner from 1, then batter)
//       HR/9.3-H;1-H  home run, two runners score
//       K             strikeout
//       W / IW        (intentional) walk
//       E6            reached on error (shortstop)
//       SB2           runner steals second
//       WP.2-3        wild pitch, runner advances
//
// This parser covers the high-frequency events. Unsupported basic tokens throw
// loudly rather than silently mis-scoring — a correctness tool must fail safe.

const FIELD: Record<string, Position> = {
  "1": "P", "2": "C", "3": "1B", "4": "2B", "5": "3B",
  "6": "SS", "7": "LF", "8": "CF", "9": "RF",
};
const POS_BY_NUM: Record<string, Position> = { ...FIELD, "10": "DH" };

const BASERUNNING_PREFIX = ["SB", "CS", "POCS", "PO", "WP", "PB", "BK", "DI", "OA", "FLE"];

type Occ = Partial<Record<Base, string>>;

function digitsToPositions(s: string): Position[] {
  return s.split("").filter((c) => FIELD[c]).map((c) => FIELD[c]);
}

function applyOccupancy(occ: Occ, moves: RunnerMove[]): Occ {
  const next: Occ = { ...occ };
  for (const m of moves) if (m.from !== "batter") delete next[m.from as Base];
  for (const m of moves) {
    if (m.to === "home" || m.to === "out") continue;
    next[m.to as Base] = m.id;
  }
  return next;
}

interface Translated {
  events: Omit<GameEvent, "seq">[];
  isPlateAppearance: boolean;
}

function parseAdvances(advStr: string, batterId: string, occ: Occ): RunnerMove[] {
  if (!advStr) return [];
  const moves: RunnerMove[] = [];
  for (const raw of advStr.split(";")) {
    const tok = raw.trim();
    const m = tok.match(/^([B123])([-X])([123H])/);
    if (!m) continue;
    const [, from, sep, to] = m;
    const ann = tok.slice(m[0].length); // e.g. "(E5)" "(UR)" "(65)"
    const onError = /\(.*(E\d|UR).*\)/.test(ann);
    const id = from === "B" ? batterId : occ[Number(from) as Base];
    if (id === undefined) continue;
    const move: RunnerMove = {
      id,
      from: from === "B" ? "batter" : (Number(from) as Base),
      to: sep === "X" ? "out" : to === "H" ? "home" : (Number(to) as Base),
    };
    if (onError) move.onError = true;
    moves.push(move);
  }
  return moves;
}

function classifyOut(fielders: Position[], mods: string[], outs: number): PaOutcome {
  if (outs >= 3) return "triple_play";
  if (outs >= 2) return "double_play";
  if (mods.includes("F")) return "flyout";
  if (mods.includes("L")) return "lineout";
  if (mods.includes("P")) return "popout";
  if (mods.includes("G")) return "groundout";
  const last = fielders[fielders.length - 1];
  return last === "LF" || last === "CF" || last === "RF" ? "flyout" : "groundout";
}

function translate(event: string, batterId: string, occ: Occ): Translated {
  // split off advances
  const dotIdx = event.indexOf(".");
  const head = dotIdx >= 0 ? event.slice(0, dotIdx) : event;
  const advStr = dotIdx >= 0 ? event.slice(dotIdx + 1) : "";
  const parts = head.split("+"); // primary + extra (e.g. K+SB2)
  const [mainAndMods, ...extras] = parts;
  const segs = mainAndMods.split("/");
  const basic = segs[0];
  const mods = segs.slice(1);

  const explicit = parseAdvances(advStr, batterId, occ);
  const events: Omit<GameEvent, "seq">[] = [];

  // pure-baserunning events keep the batter at the plate
  const brPrefix = BASERUNNING_PREFIX.find((p) => basic.startsWith(p));
  if (basic === "NP") return { events: [], isPlateAppearance: false };
  if (brPrefix) {
    events.push(baserunningEvent(brPrefix, basic, explicit, occ));
    for (const ex of extras) events.push(baserunningEvent(BASERUNNING_PREFIX.find((p) => ex.startsWith(p)) || "OA", ex, [], occ));
    return { events, isPlateAppearance: false };
  }

  // batter-completing event
  let outcome: PaOutcome;
  let fielders: Position[] = [];
  let errors: Position[] | undefined;
  const moves: RunnerMove[] = [];
  const covered = new Set(explicit.map((m) => (m.from === "batter" ? "B" : String(m.from))));

  const addBatter = (to: RunnerMove["to"], rbi = false) => {
    if (covered.has("B")) return;
    const mv: RunnerMove = { id: batterId, from: "batter", to };
    if (rbi && to === "home") mv.rbiTo = batterId;
    if (errors && to !== "out") mv.onError = true;
    moves.push(mv);
  };

  if (/^HP?$|^HR/.test(basic) && basic !== "HP") {
    outcome = "home_run"; addBatter("home", true);
  } else if (basic.startsWith("S")) {
    outcome = "single"; fielders = digitsToPositions(basic.slice(1)); addBatter(1);
  } else if (basic.startsWith("D")) {
    outcome = "double"; fielders = digitsToPositions(basic.slice(1)); addBatter(2);
  } else if (basic.startsWith("T")) {
    outcome = "triple"; fielders = digitsToPositions(basic.slice(1)); addBatter(3);
  } else if (basic.startsWith("IW") || basic === "I") {
    outcome = "intentional_walk"; addBatter(1);
  } else if (basic.startsWith("W")) {
    outcome = "walk"; addBatter(1);
  } else if (basic.startsWith("HP")) {
    outcome = "hit_by_pitch"; addBatter(1);
  } else if (basic.startsWith("K")) {
    outcome = "strikeout"; fielders = digitsToPositions(basic.slice(1)) ; if (fielders.length === 0) fielders = ["C"];
    moves.push({ id: batterId, from: "batter", to: "out", outBy: fielders });
  } else if (basic.startsWith("E")) {
    outcome = "reached_on_error"; errors = digitsToPositions(basic.slice(1)); addBatter(1);
    const m = moves.find((x) => x.from === "batter"); if (m) m.onError = true;
  } else if (basic.startsWith("FC")) {
    outcome = "fielders_choice"; fielders = digitsToPositions(basic.slice(2)); addBatter(1);
  } else if (/^[0-9]/.test(basic)) {
    // fielding out, possibly with (n) runner-out markers
    const runnerOutBases = [...basic.matchAll(/\(([B123])\)/g)].map((mm) => mm[1]);
    fielders = digitsToPositions(basic.replace(/\([^)]*\)/g, ""));
    const explicitOuts = explicit.filter((m) => m.to === "out").length;
    const batterSafe = explicit.some((m) => m.from === "batter" && m.to !== "out");
    const totalOuts = (batterSafe ? 0 : 1) + runnerOutBases.length + explicitOuts;
    outcome = classifyOut(fielders, mods, totalOuts);
    if (!batterSafe) moves.push({ id: batterId, from: "batter", to: "out", outBy: fielders });
    for (const b of runnerOutBases) {
      if (b === "B") continue;
      const id = occ[Number(b) as Base];
      if (id !== undefined && !covered.has(b)) moves.push({ id, from: Number(b) as Base, to: "out", outBy: fielders });
    }
  } else {
    throw new Error(`Unsupported Retrosheet play: "${event}"`);
  }

  // sacrifice modifiers reclassify
  if (mods.includes("SF")) outcome = "sacrifice_fly";
  if (mods.includes("SH")) outcome = "sacrifice_bunt";

  // walks/HBP: ensure forced runners advance if not given explicitly
  if ((outcome === "walk" || outcome === "intentional_walk" || outcome === "hit_by_pitch") && explicit.length === 0) {
    forceFill(occ, batterId, moves);
  }

  const allMoves = [...moves, ...explicit];
  // credit RBIs for scoring runners on batter hits / sacs (not on errors / DP)
  if (outcome !== "double_play" && outcome !== "triple_play" && outcome !== "reached_on_error") {
    for (const mv of allMoves) {
      if (mv.to === "home" && !mv.onError && !mv.rbiTo) mv.rbiTo = batterId;
    }
  }

  const pa: Omit<GameEvent, "seq"> = {
    type: "pa_result", batter: batterId, pitcher: "", outcome, runners: allMoves,
    ...(fielders.length && !moves.some((m) => m.outBy) ? { fielders } : {}),
    ...(errors ? { errors } : {}),
  } as Omit<GameEvent, "seq">;

  events.push(pa);
  for (const ex of extras) {
    const p = BASERUNNING_PREFIX.find((pp) => ex.startsWith(pp));
    if (p) events.push(baserunningEvent(p, ex, [], occ));
  }
  return { events, isPlateAppearance: true };
}

function forceFill(occ: Occ, batterId: string, moves: RunnerMove[]) {
  // batter already added to first by caller; push forced runners
  if (occ[1] === undefined) return;
  if (occ[2] === undefined) { moves.push({ id: occ[1]!, from: 1, to: 2 }); return; }
  if (occ[3] === undefined) { moves.push({ id: occ[2]!, from: 2, to: 3 }); moves.push({ id: occ[1]!, from: 1, to: 2 }); return; }
  moves.push({ id: occ[3]!, from: 3, to: "home", rbiTo: batterId });
  moves.push({ id: occ[2]!, from: 2, to: 3 });
  moves.push({ id: occ[1]!, from: 1, to: 2 });
}

function baserunningEvent(prefix: string, token: string, explicit: RunnerMove[], occ: Occ): Omit<GameEvent, "seq"> {
  const kind = ({
    SB: "stolen_base", CS: "caught_stealing", POCS: "caught_stealing", PO: "pickoff",
    WP: "wild_pitch", PB: "passed_ball", BK: "balk", DI: "other", OA: "other", FLE: "other",
  } as Record<string, string>)[prefix] || "other";

  const runners: RunnerMove[] = [...explicit];
  if (runners.length === 0) {
    const target = token.slice(prefix.length).match(/[123H]/)?.[0];
    if (prefix === "SB") {
      const to = target === "H" ? "home" : Number(target) as Base;
      const from = (to === "home" ? 3 : (Number(target) - 1)) as Base;
      if (occ[from] !== undefined) runners.push({ id: occ[from]!, from, to });
    } else if (prefix === "CS" || prefix === "POCS" || prefix === "PO") {
      const to = target === "H" ? 3 : Number(target || "2");
      const from = (prefix === "PO" ? to : to - 1) as Base;
      if (occ[from] !== undefined) runners.push({ id: occ[from]!, from, to: "out", outBy: ["C", "2B"] });
    }
  }
  return { type: "baserunning", kind: kind as any, runners } as Omit<GameEvent, "seq">;
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

export interface ParsedGame {
  setup: GameSetup;
  events: GameEvent[];
  names: Record<string, string>;
  earnedRunsData: Record<string, number>; // from `data,er` records, for validation
}

function splitCsv(line: string): string[] {
  // handles simple quoted fields
  const out: string[] = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseGame(text: string): ParsedGame {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const names: Record<string, string> = {};
  const earnedRunsData: Record<string, number> = {};
  const startsBySide: Record<TeamSide, LineupSlot[]> = { away: [], home: [] };
  const orderIdx: Record<TeamSide, Record<number, number>> = { away: {}, home: {} };

  // first pass: lineups from `start`
  for (const line of lines) {
    const f = splitCsv(line);
    if (f[0] === "start") {
      const [, id, name, teamNum, order, fieldPos] = f;
      const side: TeamSide = teamNum === "0" ? "away" : "home";
      names[id] = name;
      const slot: LineupSlot = { playerId: id, position: POS_BY_NUM[fieldPos] || "DH" };
      const i = Number(order) - 1;
      startsBySide[side][i] = slot;
      orderIdx[side][i] = i;
    }
  }

  const setup: GameSetup = {
    away: { teamId: "away", battingOrder: startsBySide.away },
    home: { teamId: "home", battingOrder: startsBySide.home },
  };

  // second pass: plays + subs in order
  const events: GameEvent[] = [];
  let seq = 1;
  let occ: Occ = {};
  let prevKey = "";
  let curPitcher: Record<TeamSide, string> = {
    away: pitcherId(startsBySide.away),
    home: pitcherId(startsBySide.home),
  };

  const orderOf: Record<TeamSide, Record<string, number>> = { away: {}, home: {} };
  startsBySide.away.forEach((s, i) => (orderOf.away[s.playerId] = i));
  startsBySide.home.forEach((s, i) => (orderOf.home[s.playerId] = i));

  for (const line of lines) {
    const f = splitCsv(line);
    if (f[0] === "data" && f[1] === "er") { earnedRunsData[f[2]] = Number(f[3]); continue; }
    if (f[0] === "sub") {
      const [, id, name, teamNum, order, fieldPos] = f;
      const side: TeamSide = teamNum === "0" ? "away" : "home";
      names[id] = name;
      const slot = Number(order) - 1;
      orderOf[side][id] = slot;
      const position = POS_BY_NUM[fieldPos] || "DH";
      events.push({ type: "substitution", seq: seq++, team: side, kind: position === "P" ? "pitching" : "defensive", slot, playerIn: id, position });
      if (position === "P") curPitcher[side] = id;
      continue;
    }
    if (f[0] !== "play") continue;

    const [, inning, teamNum, batterId, , pitches, event] = f;
    const battingSide: TeamSide = teamNum === "0" ? "away" : "home";
    const fieldingSide: TeamSide = battingSide === "away" ? "home" : "away";
    const key = inning + "-" + teamNum;
    if (key !== prevKey) { occ = {}; prevKey = key; }

    // optional: emit pitches for pitch counts
    for (const ch of pitches || "") {
      const r = pitchResult(ch);
      if (r) events.push({ type: "pitch", seq: seq++, pitcher: curPitcher[fieldingSide], result: r as any });
    }

    const { events: evs, isPlateAppearance } = translate(event, batterId, occ);
    for (const ev of evs) {
      const withMeta: any = { ...ev, seq: seq++ };
      if (ev.type === "pa_result") withMeta.pitcher = curPitcher[fieldingSide];
      if (ev.type === "baserunning" && !withMeta.pitcher) withMeta.pitcher = curPitcher[fieldingSide];
      events.push(withMeta);
      // update occupancy from this event's moves
      const moves = (ev as any).runners as RunnerMove[] | undefined;
      if (moves) occ = applyOccupancy(occ, moves);
    }
    void isPlateAppearance;
  }

  return { setup, events, names, earnedRunsData };
}

function pitcherId(slots: LineupSlot[]): string {
  const p = slots.find((s) => s && s.position === "P");
  return p ? p.playerId : (slots[0] ? slots[0].playerId : "");
}

function pitchResult(ch: string): string | null {
  switch (ch) {
    case "B": case "I": case "P": return "ball";
    case "C": return "called_strike";
    case "S": return "swinging_strike";
    case "F": return "foul";
    case "T": return "foul_tip";
    case "X": return "in_play";
    case "H": case "Y": return "hit_by_pitch";
    default: return null; // ., *, >, +, etc. are not pitches
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface Replay {
  parsed: ParsedGame;
  finalState: ReturnType<typeof reduce>;
  box: StatsResult;
}

export function replay(text: string): Replay {
  const parsed = parseGame(text);
  return {
    parsed,
    finalState: reduce(parsed.setup, parsed.events),
    box: stats(parsed.setup, parsed.events),
  };
}

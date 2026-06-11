// Plain-JS port of the scoring engine core, mirroring the TypeScript modules.
// Embedded verbatim into the scoring UI so the screen is driven by the real reducer.

function occupied(bases) { return [3, 2, 1].filter((b) => bases[b] !== undefined); }

function advanceAll(bases, n, batter, batterTo) {
  const moves = [];
  for (const b of occupied(bases)) {
    const dest = b + n;
    if (dest >= 4) moves.push({ id: bases[b], from: b, to: "home", rbiTo: batter });
    else moves.push({ id: bases[b], from: b, to: dest });
  }
  if (batterTo === "home") moves.push({ id: batter, from: "batter", to: "home", rbiTo: batter });
  else moves.push({ id: batter, from: "batter", to: batterTo });
  return moves;
}

function forceWalk(bases, batter) {
  const moves = [{ id: batter, from: "batter", to: 1 }];
  if (bases[1] === undefined) return moves;
  if (bases[2] === undefined) { moves.push({ id: bases[1], from: 1, to: 2 }); return moves; }
  if (bases[3] === undefined) {
    moves.push({ id: bases[2], from: 2, to: 3 });
    moves.push({ id: bases[1], from: 1, to: 2 });
    return moves;
  }
  moves.push({ id: bases[3], from: 3, to: "home", rbiTo: batter });
  moves.push({ id: bases[2], from: 2, to: 3 });
  moves.push({ id: bases[1], from: 1, to: 2 });
  return moves;
}

function defaultRunnerMoves(outcome, bases, batter) {
  switch (outcome) {
    case "single": return advanceAll(bases, 1, batter, 1);
    case "double": return advanceAll(bases, 2, batter, 2);
    case "triple": return advanceAll(bases, 3, batter, 3);
    case "home_run": return advanceAll(bases, 4, batter, "home");
    case "walk":
    case "intentional_walk":
    case "hit_by_pitch": return forceWalk(bases, batter);
    case "strikeout": return [{ id: batter, from: "batter", to: "out", outBy: ["C"] }];
    case "groundout":
    case "flyout":
    case "lineout":
    case "popout": return [{ id: batter, from: "batter", to: "out" }];
    case "sacrifice_fly": {
      const moves = [{ id: batter, from: "batter", to: "out" }];
      if (bases[3] !== undefined) moves.push({ id: bases[3], from: 3, to: "home", rbiTo: batter });
      return moves;
    }
    case "sacrifice_bunt": {
      const moves = [{ id: batter, from: "batter", to: "out" }];
      for (const b of occupied(bases)) {
        const dest = b + 1;
        if (dest >= 4) moves.push({ id: bases[b], from: b, to: "home" });
        else moves.push({ id: bases[b], from: b, to: dest });
      }
      return moves;
    }
    case "fielders_choice": {
      const moves = [{ id: batter, from: "batter", to: 1 }];
      const lead = [1, 2, 3].reverse().find((b) => bases[b] !== undefined);
      if (lead !== undefined) moves.push({ id: bases[lead], from: lead, to: "out", outBy: ["SS"] });
      return moves;
    }
    case "reached_on_error":
      return [
        { id: batter, from: "batter", to: 1, onError: true },
        ...occupied(bases).map((b) => {
          const dest = b + 1;
          return dest >= 4
            ? { id: bases[b], from: b, to: "home", onError: true }
            : { id: bases[b], from: b, to: dest };
        }),
      ];
    case "double_play": {
      const moves = [{ id: batter, from: "batter", to: "out", outBy: ["1B"] }];
      const lead = [1, 2, 3].find((b) => bases[b] !== undefined);
      if (lead !== undefined) moves.push({ id: bases[lead], from: lead, to: "out", outBy: ["SS", "2B"] });
      return moves;
    }
    case "triple_play": {
      const moves = [{ id: batter, from: "batter", to: "out" }];
      for (const b of occupied(bases).slice(0, 2)) moves.push({ id: bases[b], from: b, to: "out" });
      return moves;
    }
    default: return [{ id: batter, from: "batter", to: "out" }];
  }
}

function pitcherOfLineup(slots) {
  const p = slots.find((s) => s.position === "P");
  return p ? p.playerId : slots[0].playerId;
}

function initLineupState(setup) {
  return {
    away: setup.away.battingOrder.map((s) => ({ ...s })),
    home: setup.home.battingOrder.map((s) => ({ ...s })),
  };
}

function initialState(setup) {
  return {
    inning: 1, half: "top", outs: 0, count: { balls: 0, strikes: 0 },
    bases: {}, score: { away: 0, home: 0 }, battingTeam: "away",
    order: { away: 0, home: 0 },
    pitcher: { away: pitcherOfLineup(setup.away.battingOrder), home: pitcherOfLineup(setup.home.battingOrder) },
    pitchCount: {}, lineup: initLineupState(setup),
  };
}

function clone(s) {
  return {
    ...s, count: { ...s.count }, bases: { ...s.bases }, score: { ...s.score },
    order: { ...s.order }, pitcher: { ...s.pitcher }, pitchCount: { ...s.pitchCount },
    lineup: { away: s.lineup.away.map((x) => ({ ...x })), home: s.lineup.home.map((x) => ({ ...x })) },
  };
}

function fieldingSide(battingTeam) { return battingTeam === "away" ? "home" : "away"; }

function endHalfInning(s) {
  const next = clone(s);
  next.outs = 0; next.bases = {}; next.count = { balls: 0, strikes: 0 };
  if (s.half === "top") { next.half = "bottom"; next.battingTeam = "home"; }
  else { next.half = "top"; next.battingTeam = "away"; next.inning = s.inning + 1; }
  return next;
}

function advanceBatter(s) {
  const next = clone(s);
  const side = s.battingTeam;
  next.order[side] = (s.order[side] + 1) % s.lineup[side].length;
  return next;
}

function applyPitch(s, e) {
  const next = clone(s);
  next.pitchCount[e.pitcher] = (next.pitchCount[e.pitcher] || 0) + 1;
  let { balls, strikes } = next.count;
  switch (e.result) {
    case "ball": balls++; break;
    case "called_strike":
    case "swinging_strike":
    case "foul_tip": strikes++; break;
    case "foul": strikes = Math.min(strikes + 1, 2); break;
    case "in_play":
    case "hit_by_pitch": break;
  }
  next.count = { balls, strikes };
  return next;
}

function applyRunnerMoves(s, moves) {
  const next = clone(s);
  let runs = 0;
  for (const m of moves) {
    if (m.from !== "batter") delete next.bases[m.from];
    if (m.to === "home") runs++;
    else if (m.to === "out") next.outs++;
    else next.bases[m.to] = m.id;
  }
  next.score[s.battingTeam] += runs;
  return next;
}

function applyPaResult(s, e) {
  const moves = e.runners || defaultRunnerMoves(e.outcome, s.bases, e.batter);
  let next = applyRunnerMoves(s, moves);
  next.count = { balls: 0, strikes: 0 };
  next = advanceBatter(next);
  if (next.outs >= 3) next = endHalfInning(next);
  return next;
}

function applyBaserunning(s, e) {
  let next = applyRunnerMoves(s, e.runners);
  if (next.outs >= 3) next = endHalfInning(next);
  return next;
}

function applySub(s, e) {
  const next = clone(s);
  const order = next.lineup[e.team];
  order[e.slot] = { playerId: e.playerIn, position: e.position || (order[e.slot] && order[e.slot].position) || "DH" };
  if (e.kind === "pitching" || e.position === "P") next.pitcher[e.team] = e.playerIn;
  return next;
}

function apply(s, e) {
  switch (e.type) {
    case "pitch": return applyPitch(s, e);
    case "pa_result": return applyPaResult(s, e);
    case "baserunning": return applyBaserunning(s, e);
    case "substitution": return applySub(s, e);
    default: return s;
  }
}

function reduce(setup, events) {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(apply, initialState(setup));
}

function currentBatter(state) {
  const side = state.battingTeam;
  const slot = state.order[side] % state.lineup[side].length;
  return state.lineup[side][slot].playerId;
}
function currentPitcher(state) { return state.pitcher[fieldingSide(state.battingTeam)]; }

const PA_VERB = {
  single: "singles", double: "doubles", triple: "triples", home_run: "homers",
  walk: "walks", intentional_walk: "walks (IBB)", hit_by_pitch: "hit by pitch",
  strikeout: "strikes out", groundout: "grounds out", flyout: "flies out",
  lineout: "lines out", popout: "pops out", fielders_choice: "reaches on fielder's choice",
  reached_on_error: "reaches on error", sacrifice_fly: "sac fly", sacrifice_bunt: "sac bunt",
  double_play: "into a double play", triple_play: "into a triple play",
};
const BR_VERB = {
  stolen_base: "steals", caught_stealing: "caught stealing", wild_pitch: "wild pitch",
  passed_ball: "passed ball", balk: "balk", pickoff: "picked off", other: "advances",
};
function baseName(b) { return b === 2 ? "second" : b === 3 ? "third" : b === "home" ? "home" : "first"; }

function playLog(setup, events, nameOf) {
  let s = initialState(setup);
  const lines = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const tag = (s.half === "top" ? "T" : "B") + s.inning;
    if (e.type === "pa_result" || e.type === "baserunning") {
      const moves = e.type === "pa_result"
        ? (e.runners || defaultRunnerMoves(e.outcome, s.bases, e.batter))
        : e.runners;
      const runs = moves.filter((m) => m.to === "home").length;
      let text;
      if (e.type === "pa_result") {
        text = `${nameOf(e.batter)} ${PA_VERB[e.outcome] || e.outcome}`;
      } else {
        const r = e.runners[0];
        text = `${nameOf(r.id)} ${BR_VERB[e.kind] || "advances"}` +
          (e.kind === "stolen_base" && r.to !== "out" ? ` ${baseName(r.to)}` : "");
      }
      if (runs > 0) text += ` \u2014 ${runs} run${runs > 1 ? "s" : ""}`;
      lines.push({ tag, text });
    } else if (e.type === "substitution") {
      lines.push({ tag, text: `${nameOf(e.playerIn)} in${e.position ? ` at ${e.position}` : ""}` });
    }
    s = apply(s, e);
  }
  return lines.reverse();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { reduce, apply, initialState, currentBatter, currentPitcher, defaultRunnerMoves, playLog, fieldingSide };
}

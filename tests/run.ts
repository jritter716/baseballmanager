import {
  GameEvent,
  GameSetup,
  reduce,
  stats,
  validate,
  initialState,
  apply,
  LITTLE_LEAGUE_MAJORS as LL,
  restDaysRequired,
  countStatus,
  nextRestBoundary,
  isEligible,
} from "../src/index";

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${expected}, got ${actual}`); }
}
function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL ${label}`); }
}

const setup: GameSetup = {
  away: {
    teamId: "MUS",
    battingOrder: [
      { playerId: "m1", position: "SS" },
      { playerId: "m2", position: "CF" },
      { playerId: "m3", position: "1B" },
      { playerId: "m4", position: "C" },
      { playerId: "m5", position: "3B" },
      { playerId: "m6", position: "2B" },
      { playerId: "m7", position: "RF" },
      { playerId: "m8", position: "LF" },
      { playerId: "m9", position: "P" },
    ],
  },
  home: {
    teamId: "HAW",
    battingOrder: [
      { playerId: "h1", position: "SS" },
      { playerId: "h2", position: "CF" },
      { playerId: "h3", position: "1B" },
      { playerId: "h4", position: "C" },
      { playerId: "h5", position: "3B" },
      { playerId: "h6", position: "2B" },
      { playerId: "h7", position: "RF" },
      { playerId: "h8", position: "LF" },
      { playerId: "h9", position: "P" },
    ],
  },
};

// ---- Test A: a full first inning exercising many rules --------------------
const inning1: GameEvent[] = [
  { seq: 1, type: "pitch", pitcher: "h9", result: "ball" },
  { seq: 2, type: "pitch", pitcher: "h9", result: "in_play" },
  { seq: 3, type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single" },
  { seq: 4, type: "pa_result", batter: "m2", pitcher: "h9", outcome: "home_run" },
  { seq: 5, type: "pa_result", batter: "m3", pitcher: "h9", outcome: "strikeout" },
  { seq: 6, type: "pa_result", batter: "m4", pitcher: "h9", outcome: "walk" },
  { seq: 7, type: "pa_result", batter: "m5", pitcher: "h9", outcome: "double_play" },
  // bottom 1st
  { seq: 8, type: "pa_result", batter: "h1", pitcher: "m9", outcome: "reached_on_error", errors: ["SS"] },
  { seq: 9, type: "pa_result", batter: "h2", pitcher: "m9", outcome: "double" },
  { seq: 10, type: "pa_result", batter: "h3", pitcher: "m9", outcome: "single" },
  { seq: 11, type: "pa_result", batter: "h4", pitcher: "m9", outcome: "groundout" },
  { seq: 12, type: "pa_result", batter: "h5", pitcher: "m9", outcome: "flyout" },
  { seq: 13, type: "pa_result", batter: "h6", pitcher: "m9", outcome: "flyout" },
];

const st = reduce(setup, inning1);
const sx = stats(setup, inning1);

eq(st.score.away, 2, "away score");
eq(st.score.home, 1, "home score");
eq(st.inning, 2, "inning advanced to 2");
eq(st.half, "top", "back to top half");
eq(st.outs, 0, "outs reset");
eq(Object.keys(st.bases).length, 0, "bases empty");
eq(st.battingTeam, "away", "away batting in 2nd");
eq(st.order.away, 5, "away order pointer");
eq(st.order.home, 6, "home order pointer");
eq(st.pitchCount["h9"], 2, "h9 pitch count");

eq(sx.batting["m2"].hr, 1, "m2 HR");
eq(sx.batting["m2"].rbi, 2, "m2 RBI (2-run HR)");
eq(sx.batting["m2"].r, 1, "m2 run scored");
eq(sx.batting["m2"].tb, 4, "m2 total bases");
eq(sx.batting["m1"].h, 1, "m1 hit");
eq(sx.batting["m1"].r, 1, "m1 scored on HR");
eq(sx.batting["m3"].so, 1, "m3 strikeout");
eq(sx.batting["m4"].bb, 1, "m4 walk");
eq(sx.batting["m4"].ab, 0, "m4 no AB on walk");
eq(sx.batting["m5"].ab, 1, "m5 AB on DP");
eq(sx.batting["m5"].h, 0, "m5 no hit on DP");

eq(sx.batting["h1"].r, 1, "h1 scored");
eq(sx.batting["h1"].h, 0, "h1 reached on error, no hit");
eq(sx.batting["h1"].ab, 1, "h1 AB on reached-on-error");
eq(sx.batting["h2"].doubles, 1, "h2 double");
eq(sx.batting["h3"].rbi, 1, "h3 RBI on single");

eq(sx.pitching["h9"].h, 2, "h9 hits allowed");
eq(sx.pitching["h9"].r, 2, "h9 runs");
eq(sx.pitching["h9"].er, 2, "h9 earned runs");
eq(sx.pitching["h9"].bb, 1, "h9 walks");
eq(sx.pitching["h9"].so, 1, "h9 strikeouts");
eq(sx.pitching["h9"].outs, 3, "h9 outs recorded");
eq(sx.pitching["h9"].bf, 5, "h9 batters faced");

eq(sx.pitching["m9"].h, 2, "m9 hits allowed");
eq(sx.pitching["m9"].r, 1, "m9 runs");
eq(sx.pitching["m9"].er, 0, "m9 earned runs (run was unearned)");
eq(sx.pitching["m9"].outs, 3, "m9 outs recorded");
eq(sx.pitching["m9"].bf, 6, "m9 batters faced");

eq(sx.fielding["m1"].e, 1, "m1 charged with error");
ok((sx.fielding["h4"]?.po ?? 0) >= 1, "home catcher credited a putout");

// ---- Test B: pitch-count rules (pure) -------------------------------------
eq(restDaysRequired(LL, 0), 0, "rest 0 pitches");
eq(restDaysRequired(LL, 47), 2, "rest 47 pitches");
eq(restDaysRequired(LL, 50), 2, "rest 50 pitches");
eq(restDaysRequired(LL, 51), 3, "rest 51 pitches");
eq(restDaysRequired(LL, 100), 4, "rest 100 pitches");
const nb = nextRestBoundary(LL, 47);
eq(nb?.atPitches, 51, "next boundary at 51");
eq(nb?.restDays, 3, "next boundary costs 3 days");
eq(countStatus(LL, 85).atLimit, true, "at daily limit");
eq(countStatus(LL, 80).approaching, true, "approaching limit");
eq(countStatus(LL, 80).atLimit, false, "not yet at limit");
eq(isEligible(LL, [{ date: "2026-06-01", pitches: 60 }], "2026-06-02").eligible, false, "ineligible, not enough rest");
eq(isEligible(LL, [{ date: "2026-05-28", pitches: 60 }], "2026-06-02").eligible, true, "eligible after rest");
eq(isEligible(LL, [{ date: "2026-06-01", pitches: 15 }], "2026-06-02").eligible, true, "eligible, low pitch count");

// ---- Test C: validation rejects an impossible move ------------------------
const fresh = initialState(setup);
const bad: GameEvent = {
  seq: 1, type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single",
  runners: [{ id: "ghost", from: 2, to: 3 }, { id: "m1", from: "batter", to: 1 }],
};
const problems = validate(fresh, bad);
ok(problems.some((p) => p.code === "empty_base"), "validation flags empty base");

// ---- Test D: stolen base + pitching change --------------------------------
const dEvents: GameEvent[] = [
  { seq: 1, type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single" },
  { seq: 2, type: "baserunning", kind: "stolen_base", runners: [{ id: "m1", from: 1, to: 2 }] },
  { seq: 3, type: "substitution", team: "home", kind: "pitching", slot: 8, playerIn: "h10", playerOut: "h9", position: "P" },
  { seq: 4, type: "pitch", pitcher: "h10", result: "ball" },
];
const dst = reduce(setup, dEvents);
eq(dst.bases[2], "m1", "runner stole second");
eq(dst.bases[1], undefined, "first base now empty");
eq(dst.pitcher.home, "h10", "pitching change applied");
eq(dst.pitchCount["h10"], 1, "new pitcher pitch count");

// also confirm apply() and reduce() agree (determinism on the same log)
const replay = inning1.reduce(apply, initialState(setup));
eq(replay.score.away, st.score.away, "manual replay matches reduce (away)");
eq(replay.score.home, st.score.home, "manual replay matches reduce (home)");

// ---- Test E: consecutive walks load the bases (regression) ----------------
const walks: GameEvent[] = [
  { seq: 1, type: "pa_result", batter: "m1", pitcher: "h9", outcome: "walk" },
  { seq: 2, type: "pa_result", batter: "m2", pitcher: "h9", outcome: "walk" },
  { seq: 3, type: "pa_result", batter: "m3", pitcher: "h9", outcome: "walk" },
];
const w1 = reduce(setup, [walks[0]]);
eq(w1.bases[1], "m1", "walk 1: runner on first");
const w2 = reduce(setup, [walks[0], walks[1]]);
eq(w2.bases[1], "m2", "walk 2: batter on first");
eq(w2.bases[2], "m1", "walk 2: forced runner on second (was the bug)");
const w3 = reduce(setup, walks);
eq(w3.bases[1], "m3", "walk 3: bases loaded - first");
eq(w3.bases[2], "m2", "walk 3: bases loaded - second");
eq(w3.bases[3], "m1", "walk 3: bases loaded - third");
const w4 = reduce(setup, [...walks, { seq: 4, type: "pa_result", batter: "m4", pitcher: "h9", outcome: "walk" }]);
eq(w4.score.away, 1, "walk 4: forced run scores");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Runner-advancement override helper: editableRunners + toRunnerMoves.
// Verifies that accepting defaults reproduces the engine defaults, and that
// overrides fold through reduce/stats to the correct score, bases, and RBI.
import {
  GameEvent, GameSetup, RunnerMove,
  editableRunners, toRunnerMoves, defaultRunnerMoves,
  reduce, stats,
} from "../src/index";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}

function lineup(prefix: string) {
  const pos = ["SS", "CF", "1B", "C", "3B", "2B", "RF", "LF", "P"] as const;
  return { teamId: prefix, battingOrder: pos.map((p, i) => ({ playerId: prefix + (i + 1), position: p })) };
}
const setup: GameSetup = { away: lineup("m"), home: lineup("h") };

// --- editableRunners: model shape + pre-fill -------------------------------
{
  // Runner on first, batter doubles. Default: runner 1->3, batter->2.
  const bases = { 1: "m1" };
  const edits = editableRunners("double", bases, "m2");
  eq(edits.length, 2, "double w/ runner on 1st: batter + 1 runner");
  eq(edits[0], { id: "m2", from: "batter", to: 2, onError: false, options: [1, 2, 3, "home", "out"] }, "batter pre-filled to 2nd");
  eq(edits[1], { id: "m1", from: 1, to: 3, onError: false, options: [1, 2, 3, "home", "out"] }, "runner pre-filled to 3rd; options are hold/advance/score/out");
}
{
  // Groundout with a runner on second: default holds the runner (no move),
  // so the editable model shows it holding at 2nd.
  const edits = editableRunners("groundout", { 2: "m1" }, "m2");
  eq(edits[1], { id: "m1", from: 2, to: 2, onError: false, options: [2, 3, "home", "out"] }, "held runner shown holding at origin");
}

// --- toRunnerMoves: accepting defaults == defaultRunnerMoves ----------------
function sameAsDefault(outcome: any, bases: any, batter: string, label: string) {
  const edits = editableRunners(outcome, bases, batter);
  const got = toRunnerMoves(edits, outcome, batter, bases);
  const want = defaultRunnerMoves(outcome, bases, batter);
  // Compare by folding both into identical resulting state via a single PA.
  const ev = (runners?: RunnerMove[]): GameEvent[] => [
    { seq: 1, type: "pa_result", batter, pitcher: "h9", outcome, runners } as GameEvent,
  ];
  const a = reduce(setup, ev(got));
  const b = reduce(setup, ev(want));
  eq([a.score, a.bases, a.outs], [b.score, b.bases, b.outs], `defaults round-trip: ${label}`);
}
sameAsDefault("single", {}, "m1", "single bases empty");
sameAsDefault("single", { 1: "m1" }, "m2", "single runner on 1st");
sameAsDefault("double", { 1: "m1", 3: "m3" }, "m2", "double, runners corners");
sameAsDefault("home_run", { 1: "m1", 2: "m2", 3: "m3" }, "m4", "grand slam");
sameAsDefault("walk", { 1: "m1", 2: "m2" }, "m3", "walk first+second");
sameAsDefault("groundout", { 2: "m1" }, "m2", "groundout runner on 2nd holds");
sameAsDefault("strikeout", {}, "m1", "strikeout");
sameAsDefault("double_play", { 1: "m1" }, "m2", "double play");

// --- the headline override: runner scores from first on a double -----------
{
  const bases = { 1: "m1" };
  const edits = editableRunners("double", bases, "m2");
  // Override the runner (from 1st) to score instead of stopping at 3rd.
  edits[1].to = "home";
  const runners = toRunnerMoves(edits, "double", "m2", bases);
  const events: GameEvent[] = [{ seq: 1, type: "pa_result", batter: "m2", pitcher: "h9", outcome: "double", runners }];
  const s = reduce(setup, events);
  eq(s.score.away, 1, "override: runner scores from first -> 1 run");
  eq(s.bases, { 2: "m2" }, "override: batter stands on 2nd, no one left on 1st/3rd");
  const box = stats(setup, events);
  eq(box.batting["m2"].rbi, 1, "override: batter credited 1 RBI for the run");
  eq(box.batting["m2"].doubles, 1, "override: still recorded as a double");
}

// --- override: runner thrown out advancing (no run, an out) -----------------
{
  const bases = { 2: "m1" };
  const edits = editableRunners("single", bases, "m2");
  // Default would send the runner from 2nd to 3rd; instead he's out at home.
  edits[1].to = "out";
  const runners = toRunnerMoves(edits, "single", "m2", bases);
  const s = reduce(setup, [{ seq: 1, type: "pa_result", batter: "m2", pitcher: "h9", outcome: "single", runners }]);
  eq(s.outs, 1, "override: runner thrown out -> 1 out");
  eq(s.score.away, 0, "override: no run scored");
  eq(s.bases, { 1: "m2" }, "override: batter on 1st, runner gone");
}

// --- override: run scored on an error is unearned, no RBI ------------------
{
  const bases = { 3: "m1" };
  const edits = editableRunners("groundout", bases, "m2");
  edits[1].to = "home";        // runner scores from third
  edits[1].onError = true;     // ...because of an error
  const runners = toRunnerMoves(edits, "groundout", "m2", bases);
  const events: GameEvent[] = [{ seq: 1, type: "pa_result", batter: "m2", pitcher: "h9", outcome: "groundout", runners }];
  const move = runners.find((m) => m.to === "home")!;
  eq(move.onError === true && move.rbiTo === undefined, true, "error run: onError set, no RBI credited");
  const box = stats(setup, events);
  eq(box.batting["m2"].rbi, 0, "error run: batter gets no RBI");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

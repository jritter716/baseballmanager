import { GameEvent, GameSetup, decisions } from "../src/index";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}

function lineup(prefix: string) {
  const pos = ["SS", "CF", "1B", "C", "3B", "2B", "RF", "LF", "P"] as const;
  return { teamId: prefix, battingOrder: pos.map((p, i) => ({ playerId: prefix + (i + 1), position: p })) };
}
const setup: GameSetup = { away: lineup("m"), home: lineup("h") };

// Builder: emits exactly 3 outs per half-inning, with optional home runs first.
function buildGame(plan: (b: Builder) => void): GameEvent[] {
  const b = new Builder();
  plan(b);
  return b.events;
}
class Builder {
  events: GameEvent[] = [];
  seq = 1;
  awayP = "m9";
  homeP = "h9";
  private push(o: Record<string, unknown>) { this.events.push({ ...o, seq: this.seq++ } as unknown as GameEvent); }
  half(batting: "away" | "home", hrBatters: string[] = []) {
    const def = batting === "away" ? this.homeP : this.awayP;
    for (const bat of hrBatters) this.push({ type: "pa_result", batter: bat, pitcher: def, outcome: "home_run" });
    const k = batting === "away" ? "m1" : "h1";
    for (let i = 0; i < 3; i++) this.push({ type: "pa_result", batter: k, pitcher: def, outcome: "strikeout" });
  }
  subPitcher(team: "away" | "home", playerIn: string) {
    this.push({ type: "substitution", team, kind: "pitching", slot: 8, playerIn, position: "P" });
    if (team === "away") this.awayP = playerIn; else this.homeP = playerIn;
  }
}

// ---- Scenario A: complete-game shutout, away 1-0 --------------------------
const gA = buildGame((b) => {
  b.half("away", ["m1"]); b.half("home");
  for (let i = 2; i <= 9; i++) { b.half("away"); b.half("home"); }
});
const dA = decisions(setup, gA);
eq(dA.winner, "away", "A winner");
eq(dA.win, "m9", "A win -> away starter (complete game)");
eq(dA.loss, "h9", "A loss -> home starter");
eq(dA.save, null, "A no save (winner finished)");

// ---- Scenario B: starter win + reliever save, away 2-1 --------------------
const gB = buildGame((b) => {
  b.half("away", ["m1", "m2"]); b.half("home");        // away 2-0
  b.half("away"); b.half("home");
  b.half("away"); b.half("home", ["h1"]);              // home 2-1
  for (let i = 4; i <= 8; i++) { b.half("away"); b.half("home"); }
  b.half("away");                                       // top 9
  b.subPitcher("away", "m10");                          // closer enters, lead 1
  b.half("home");                                       // bottom 9
});
const dB = decisions(setup, gB);
eq(dB.winner, "away", "B winner");
eq(dB.win, "m9", "B win -> away starter (24 outs)");
eq(dB.loss, "h9", "B loss -> home starter (charged go-ahead)");
eq(dB.save, "m10", "B save -> closer (entered up 1, 1 inning)");

// ---- Scenario C: reliever win (lead lost then retaken), away 3-2 ----------
const gC = buildGame((b) => {
  b.half("away", ["m1"]);            // away 1-0 (top1)
  b.half("home", ["h1", "h2"]);      // home 2 (bottom1) -> 1-2 home leads
  b.subPitcher("away", "m10");       // reliever for away
  b.half("away");                    // top2 scoreless
  b.half("home");                    // bottom2 scoreless
  b.half("away", ["m3", "m4"]);      // top3 away 2 -> 3-2 away leads for good
  b.half("home");                    // bottom3
  for (let i = 4; i <= 9; i++) { b.half("away"); b.half("home"); }
});
const dC = decisions(setup, gC);
eq(dC.winner, "away", "C winner");
eq(dC.win, "m10", "C win -> reliever (pitcher of record at go-ahead)");
eq(dC.loss, "h9", "C loss -> home starter");
eq(dC.save, null, "C no save (winner is the finisher/reliever)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

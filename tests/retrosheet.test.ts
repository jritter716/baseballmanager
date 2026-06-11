import { replay } from "../src/retrosheet";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}

// A hand-built game in real Retrosheet event syntax.
// Top 1st: walk, single (runner to 3rd), 3-run homer, K, groundout, flyout  -> 3 runs
// Bot 1st: reach on error, stolen base, RBI double (unearned), K, groundout, flyout -> 1 run
const GAME = `
id,SAMP01
info,visteam,MUS
info,hometeam,HAW
start,m1,"Avery P",0,1,6
start,m2,"Mason T",0,2,8
start,m3,"Diego R",0,3,3
start,m4,"Liam K",0,4,2
start,m5,"Noah B",0,5,5
start,m6,"Eli W",0,6,4
start,m7,"Caleb M",0,7,9
start,m8,"Owen S",0,8,7
start,m9,"Jack D",0,9,1
start,h1,"Tyler M",1,1,6
start,h2,"Sam K",1,2,8
start,h3,"Marcus D",1,3,3
start,h4,"Cole R",1,4,2
start,h5,"Drew L",1,5,5
start,h6,"Ben A",1,6,4
start,h7,"Luca P",1,7,9
start,h8,"Ivan G",1,8,7
start,h9,"Reese T",1,9,1
play,1,0,m1,00,,W
play,1,0,m2,00,,S8.1-3
play,1,0,m3,00,,HR.3-H;1-H
play,1,0,m4,00,,K
play,1,0,m5,00,,53
play,1,0,m6,00,,8/F
play,1,1,h1,00,,E6
play,1,1,h2,00,,SB2
play,1,1,h2,00,,D7.2-H
play,1,1,h3,00,,K
play,1,1,h4,00,,63
play,1,1,h5,00,,8/F
data,er,h9,3
data,er,m9,0
`;

const r = replay(GAME);
const { finalState: s, box, parsed } = r;

// game state
eq(s.score.away, 3, "away scored 3");
eq(s.score.home, 1, "home scored 1");
eq(s.inning, 2, "advanced to inning 2");
eq(s.half, "top", "back to top");
eq(s.outs, 0, "outs reset");

// batting
eq(box.batting["m3"].hr, 1, "m3 home run");
eq(box.batting["m3"].rbi, 3, "m3 three RBI");
eq(box.batting["m2"].h, 1, "m2 single");
eq(box.batting["m1"].bb, 1, "m1 walked");
eq(box.batting["h2"].h, 1, "h2 double");
eq(box.batting["h2"].rbi, 1, "h2 one RBI");
eq(box.batting["h1"].h, 0, "h1 reached on error, no hit");

// pitching
eq(box.pitching["h9"].h, 2, "h9 hits allowed");
eq(box.pitching["h9"].r, 3, "h9 runs");
eq(box.pitching["h9"].er, 3, "h9 earned runs");
eq(box.pitching["h9"].bb, 1, "h9 walks");
eq(box.pitching["h9"].so, 1, "h9 strikeouts");
eq(box.pitching["h9"].outs, 3, "h9 outs");
eq(box.pitching["h9"].bf, 6, "h9 batters faced");
eq(box.pitching["m9"].h, 1, "m9 hits allowed");
eq(box.pitching["m9"].r, 1, "m9 runs");
eq(box.pitching["m9"].er, 0, "m9 earned (run was unearned)");
eq(box.pitching["m9"].bf, 5, "m9 batters faced (steal not a PA)");

// fielding
eq(box.fielding["m1"].e, 1, "m1 (SS) charged the error");

// the payoff: computed earned runs match the file's own data,er records
eq(box.pitching["h9"].er, parsed.earnedRunsData["h9"], "h9 ER matches Retrosheet data,er");
eq(box.pitching["m9"].er, parsed.earnedRunsData["m9"], "m9 ER matches Retrosheet data,er");

// names came through
eq(parsed.names["m3"], "Diego R", "name parsed");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

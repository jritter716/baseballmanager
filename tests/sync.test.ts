import { GameSetup } from "../src/types";
import { GameStore } from "../src/store";
import { EventEnvelope, mergeLogs, pendingToPush, highWaterMark } from "../src/sync";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}

function lineup(p: string) {
  const pos = ["SS", "CF", "1B", "C", "3B", "2B", "RF", "LF", "P"] as const;
  return { teamId: p, battingOrder: pos.map((x, i) => ({ playerId: p + (i + 1), position: x })) };
}
const setup: GameSetup = { away: lineup("m"), home: lineup("h") };

function env(id: string, seq: number, batter: string, outcome: string): EventEnvelope {
  return { id, seq, type: "pa_result", batter, pitcher: "h9", outcome } as EventEnvelope;
}

// ---- sync: pending + merge -------------------------------------------------
const remote: EventEnvelope[] = [env("a", 1, "m1", "single"), env("b", 2, "m2", "single")];
const local: EventEnvelope[] = [
  env("a", 1, "m1", "single"),
  env("b", 2, "m2", "single"),
  env("c", 3, "m3", "walk"),   // pending (scored offline)
  env("d", 4, "m4", "strikeout"),
];
const pending = pendingToPush(local, new Set(remote.map((e) => e.id)));
eq(pending.length, 2, "two events pending push");
eq(pending[0].id, "c", "pending preserves order");

const merged = mergeLogs(local, remote);
eq(merged.length, 4, "merge dedups by id");
eq(merged.map((e) => e.id).join(""), "abcd", "merge orders remote then local-only");
eq(merged[2].seq, 3, "pending renumbered after remote max");
eq(merged[3].seq, 4, "pending renumbered sequentially");
eq(highWaterMark(remote), 2, "high-water mark");

// ---- store: idempotent append + derived view -------------------------------
const store = new GameStore();
const g = store.create(setup);

const batch1 = [
  { id: "e1", type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single" },
  { id: "e2", type: "pa_result", batter: "m2", pitcher: "h9", outcome: "home_run" },
] as any[];

const a1 = store.append(g.id, batch1);
eq(a1.length, 2, "first append stores 2");
const a2 = store.append(g.id, batch1); // resend same batch (flaky network)
eq(a2.length, 0, "resend is idempotent (0 new)");
eq(a1[0].seq, 1, "server assigns seq 1");
eq(a1[1].seq, 2, "server assigns seq 2");

store.append(g.id, [
  { id: "e3", type: "pa_result", batter: "m3", pitcher: "h9", outcome: "strikeout" },
  { id: "e4", type: "pa_result", batter: "m4", pitcher: "h9", outcome: "groundout" },
  { id: "e5", type: "pa_result", batter: "m5", pitcher: "h9", outcome: "flyout" },
] as any[]);

const view = store.view(g.id);
eq(view.scoreboard.score.away, 2, "store view: 2-run homer scored");
eq(view.scoreboard.inning, 1, "store view: still inning 1 after top half");
eq(view.scoreboard.half, "bottom", "store view: now bottom half");
eq(view.box.batting["m2"].hr, 1, "store view: box score derived");
eq(store.since(g.id, 2).length, 3, "since(2) returns the last 3 events");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

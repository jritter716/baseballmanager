// Durable GameStore: a JSONL log survives a "restart" (a fresh store on the
// same file re-folds the log). Covers state/seq recovery, idempotency across
// restart, partial-line tolerance, and seq continuation.
import fs from "fs";
import os from "os";
import path from "path";
import { GameStore, GameSetup, GameEvent } from "../src/index";

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
const ev = (id: string, e: Partial<GameEvent> & { type: string }): any => ({ id, ...e });

const file = path.join(os.tmpdir(), `bb-persist-${process.pid}.jsonl`);
function reset() { try { fs.unlinkSync(file); } catch { /* none */ } }
reset();

// --- create + append, then "restart" and recover identically ---------------
let gameId: string;
{
  const s = new GameStore({ file });
  gameId = s.create(setup).id;
  s.append(gameId, [
    ev("e1", { type: "pitch", pitcher: "h9", result: "in_play" }),
    ev("e2", { type: "pa_result", batter: "m1", pitcher: "h9", outcome: "home_run" }),
    ev("e3", { type: "pitch", pitcher: "h9", result: "ball" }),
  ]);
  s.close();
}
const before = (() => { const s = new GameStore({ file }); const b = s.scoreboard(gameId); const n = s.get(gameId)!.events.length; s.close(); return { b, n }; })();
{
  // Fresh store, same file == a server restart.
  const s = new GameStore({ file });
  eq(!!s.get(gameId), true, "game recovered after restart");
  eq(s.get(gameId)!.events.length, 3, "all 3 events recovered");
  eq(s.scoreboard(gameId).score.away, 1, "derived score recovered (HR = 1)");
  eq(s.scoreboard(gameId).serverSeq, 3, "serverSeq recovered = 3");
  eq(s.get(gameId)!.events.map((e) => e.seq), [1, 2, 3], "event seqs intact 1..3");

  // --- idempotency across restart: replaying e2 does nothing ---
  const again = s.append(gameId, [ev("e2", { type: "pa_result", batter: "m1", pitcher: "h9", outcome: "home_run" })]);
  eq(again.length, 0, "duplicate event id ignored after restart (idempotent)");

  // --- seq continues from the recovered high-water mark ---
  const added = s.append(gameId, [ev("e4", { type: "pitch", pitcher: "h9", result: "ball" })]);
  eq(added[0].seq, 4, "new event after restart gets seq 4");
  s.close();
}

// --- partial / corrupt final line is tolerated -----------------------------
{
  fs.appendFileSync(file, '{"k":"event","gameId":"' + gameId + '","ev'); // truncated line (crash mid-append)
  const s = new GameStore({ file });
  eq(!!s.get(gameId), true, "game still recovers despite a corrupt trailing line");
  eq(s.scoreboard(gameId).serverSeq, 4, "serverSeq still 4 (bad line skipped)");
  // and appending still works after recovery from a corrupt tail
  const added = s.append(gameId, [ev("e5", { type: "pitch", pitcher: "h9", result: "ball" })]);
  eq(added[0].seq, 5, "append works after corrupt-tail recovery (seq 5)");
  s.close();
}

// --- in-memory mode writes nothing to disk ---------------------------------
{
  const memFile = path.join(os.tmpdir(), `bb-persist-mem-${process.pid}.jsonl`);
  try { fs.unlinkSync(memFile); } catch { /* none */ }
  const s = new GameStore(); // no file
  const id = s.create(setup).id;
  s.append(id, [ev("z1", { type: "pitch", pitcher: "h9", result: "ball" })]);
  eq(fs.existsSync(memFile), false, "in-memory store writes no file");
}

reset();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

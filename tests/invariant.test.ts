// Event-stream invariant (§3): every appended event carries org/team scope, a
// server timestamp, and (when known) the recording actor — without affecting the
// pure reducer, which must ignore these fields entirely.
import { GameStore, GameSetup, GameEvent, reduce } from "../src/index";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}

const lineup = (p: string) => ({ teamId: p, battingOrder: [{ playerId: p + "1", position: "P" as const }] });
const ev = (e: any): any => e;

// ---- a game created from rosters carries the refs; events get stamped ----
{
  const setup: GameSetup = { orgId: "org1", awayTeamId: "tAway", homeTeamId: "tHome", away: lineup("a"), home: lineup("h") };
  const store = new GameStore();
  const id = store.create(setup).id;
  const out = store.append(id, [
    ev({ id: "e1", type: "pitch", pitcher: "h1", result: "in_play" }),
    ev({ id: "e2", type: "pa_result", batter: "a1", pitcher: "h1", outcome: "home_run" }),
  ], { actor: "person-scorer" });

  eq(out[0].orgId, "org1", "event carries orgId from the game");
  eq(out[0].teamId, "tHome", "event teamId = the home team (owns the stream)");
  eq(typeof out[0].timestamp, "string", "event has a server timestamp");
  eq(Number.isNaN(Date.parse(out[0].timestamp!)) , false, "timestamp is a valid ISO date");
  eq(out[0].actor, "person-scorer", "event carries the recording actor");
  eq(out[1].timestamp! >= out[0].timestamp!, true, "timestamps are non-decreasing");

  // The reducer must ignore the invariant fields entirely.
  const stamped = store.get(id)!.events;
  const stripped = stamped.map((e) => { const { orgId, teamId, timestamp, actor, ...rest } = e; return rest as GameEvent; });
  const a = reduce(setup, stamped), b = reduce(setup, stripped);
  eq(JSON.stringify([a.score, a.bases, a.outs, a.inning]), JSON.stringify([b.score, b.bases, b.outs, b.inning]),
    "reducer ignores org/team/timestamp/actor (state identical with or without them)");
  eq(a.score.away, 1, "scoring still correct with stamped events (HR = 1)");
}

// ---- a legacy game without refs: timestamp still stamped, no crash, no scope ----
{
  const setup: GameSetup = { away: lineup("a"), home: lineup("h") }; // no org/team refs
  const store = new GameStore();
  const id = store.create(setup).id;
  const out = store.append(id, [ev({ id: "x1", type: "pitch", pitcher: "h1", result: "ball" })]);
  eq(out[0].orgId, undefined, "no orgId stamped when the game has none");
  eq(out[0].teamId, undefined, "no teamId stamped when the game has none");
  eq(typeof out[0].timestamp, "string", "timestamp still stamped on a legacy game");
}

// ---- actor is optional (omitted until auth is enforced) ----
{
  const setup: GameSetup = { orgId: "org1", homeTeamId: "tHome", away: lineup("a"), home: lineup("h") };
  const store = new GameStore();
  const id = store.create(setup).id;
  const out = store.append(id, [ev({ id: "n1", type: "pitch", pitcher: "h1", result: "ball" })]); // no meta
  eq(out[0].actor, undefined, "actor omitted when not provided");
  eq(out[0].teamId, "tHome", "teamId still stamped without an actor");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

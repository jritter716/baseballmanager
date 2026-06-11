// Offline-first sync client tests. Drives web/sync-client.js against the REAL
// GameStore (compiled to dist) through a fake fetch, so the server's idempotent
// append + seq assignment are exercised with no socket. Run via `npm test`.
import { createSyncClient, memoryStorage } from "../web/sync-client.js";
import { GameStore } from "../dist/src/store.js";

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL ${label}\n  got:  ${a}\n  want: ${e}`); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; console.error(`FAIL ${label}`); } }

// A fake server: routes fetch() calls into a GameStore instance.
function makeServer() {
  const store = new GameStore();
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url, "http://test");
    const parts = u.pathname.split("/").filter(Boolean);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (method === "POST" && parts.length === 1 && parts[0] === "games") {
      return resp(201, { id: store.create(body.setup).id });
    }
    if (parts[0] === "games" && parts[1]) {
      const id = parts[1], sub = parts[2];
      if (!store.get(id)) return resp(404, { error: "no such game" });
      if (method === "POST" && sub === "events") {
        const appended = store.append(id, body.events || []);
        return resp(200, { appended: appended.map((e) => ({ id: e.id, seq: e.seq })), serverSeq: store.scoreboard(id).serverSeq });
      }
      if (method === "GET" && sub === "events") {
        const since = Number(u.searchParams.get("since") || 0);
        return resp(200, { events: store.since(id, since), serverSeq: store.scoreboard(id).serverSeq });
      }
    }
    return resp(404, { error: "not found" });
  }
  return { store, fetchImpl };
}

const setup = {
  away: { teamId: "A", battingOrder: [{ playerId: "a1", position: "P", name: "Ann" }] },
  home: { teamId: "H", battingOrder: [{ playerId: "h1", position: "P", name: "Hal" }] },
};
const pitch = (r = "ball") => ({ type: "pitch", pitcher: "h1", result: r });
const tick = () => new Promise((r) => setTimeout(r, 0));

async function run() {
  const { store, fetchImpl } = makeServer();
  const storage = memoryStorage();
  let netUp = true;
  const client = createSyncClient({
    setup, baseUrl: "", storage, fetchImpl,
    online: () => netUp, autoFlush: false, installListeners: false,
  });

  // --- online: commit + flush pushes to the server ---
  await client.init();                       // creates the game shell
  ok(!!client.gameId, "game created on init");
  client.commit([pitch("ball")]);            // one queued event
  eq(client.status().pending, 1, "one event queued before flush");
  await client.flushNow();
  eq(client.status().pending, 0, "no pending after online flush");
  eq(store.get(client.gameId).events.length, 1, "server has 1 event after flush");
  eq(store.get(client.gameId).events[0].seq, 1, "server assigned seq 1");

  // --- offline: events queue locally, server untouched ---
  netUp = false;
  client.commit([pitch("ball")]);
  client.commit([pitch("ball"), { type: "pa_result", batter: "a1", pitcher: "h1", outcome: "walk" }]);
  eq(client.status().pending, 3, "three events queued while offline");
  eq(client.status().online, false, "status reports offline");
  await client.flushNow();                   // no-op offline
  eq(store.get(client.gameId).events.length, 1, "server still has 1 event while offline");
  ok(client.getLog().length === 4, "local log has all 4 events offline (optimistic)");

  // --- reconnect: reconcile pulls, merges, pushes the queue ---
  netUp = true;
  await client.reconcile();
  eq(client.status().pending, 0, "queue drained after reconnect");
  eq(store.get(client.gameId).events.length, 4, "server caught up to 4 events");
  const seqs = store.get(client.gameId).events.map((e) => e.seq);
  eq(seqs, [1, 2, 3, 4], "server seqs are contiguous 1..4");
  const ids = new Set(store.get(client.gameId).events.map((e) => e.id));
  ok(ids.size === 4, "no duplicate events on the server");

  // --- idempotency: re-flushing changes nothing ---
  await client.flushNow();
  eq(store.get(client.gameId).events.length, 4, "re-flush is idempotent (still 4)");

  // --- undo only works on un-synced events ---
  ok(client.undo() === false, "cannot undo an already-synced action");
  netUp = false;
  client.commit([pitch("foul")]);
  eq(client.status().pending, 1, "one pending after offline commit");
  ok(client.undo() === true, "can undo a pending (un-synced) action");
  eq(client.status().pending, 0, "pending cleared after undo");
  eq(client.getLog().length, 4, "log back to 4 after undo");

  // --- resume from persisted storage (same blob, new client) ---
  netUp = true;
  await client.flushNow();                   // ensure clean state persisted (still 4)
  const resumed = createSyncClient({
    setup, baseUrl: "", storage, fetchImpl,
    online: () => true, autoFlush: false, installListeners: false,
  });
  await resumed.init();
  eq(resumed.getLog().length, 4, "resumed client restores the log from storage");
  eq(resumed.gameId, client.gameId, "resumed client keeps the same gameId");
  await resumed.reconcile();
  eq(store.get(client.gameId).events.length, 4, "resume + reconcile does not duplicate");

  // --- reconcile picks up events that appeared on the server elsewhere ---
  store.append(client.gameId, [{ id: "external-1", type: "pitch", pitcher: "h1", result: "ball" }]);
  await resumed.reconcile();
  ok(resumed.getLog().some((e) => e.id === "external-1"), "reconcile pulls server-only events into the local log");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

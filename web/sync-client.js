// Offline-first sync client for the scorer's device.
//
// The local event log is the optimistic source of truth: every scored event is
// applied locally instantly (the pure reducer), appended to a persisted queue,
// and POSTed to the server when connectivity allows. On (re)connect it
// reconciles with the authoritative server log using the engine's pure
// reconciliation primitives (mergeLogs / pendingToPush / highWaterMark).
//
// Everything external is injectable (fetch, storage, connectivity, timers, uuid)
// so this module can be exercised headlessly in Node as well as in the browser.
import { mergeLogs, pendingToPush, highWaterMark } from "./dist/engine.js";

function defaultUuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** A localStorage-backed key/value store (one JSON blob). Falls back to memory. */
export function browserStorage(key = "scorekeeper-game") {
  const ok = (() => { try { return typeof localStorage !== "undefined"; } catch { return false; } })();
  if (!ok) return memoryStorage();
  return {
    async load() { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
    async save(state) { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* quota: ignore */ } },
    async clear() { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };
}

/** An in-memory store, for tests. */
export function memoryStorage(seed = null) {
  let blob = seed ? JSON.stringify(seed) : null;
  return {
    async load() { return blob ? JSON.parse(blob) : null; },
    async save(state) { blob = JSON.stringify(state); },
    async clear() { blob = null; },
  };
}

export function createSyncClient(opts) {
  const {
    setup,
    gameId: initialGameId = null,   // open an existing game instead of creating one
    personId = "",                  // who is acting (sent as X-Person-Id for access)
    baseUrl = "",
    storage = browserStorage(),
    fetchImpl = (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null),
    online,
    now = () => Date.now(),
    uuid = defaultUuid,
    onChange = () => {},
    onStatus = () => {},
    autoFlush = true,
    flushDelay = 500,
    installListeners = (typeof window !== "undefined"),
  } = opts;

  // Persisted state.
  let st = { gameId: initialGameId, log: [], groups: [], ackedIds: [], hwm: 0, seqCounter: 0 };
  let acked = new Set();
  let manualOnline = null;     // tests / explicit offline toggle
  let lastError = null;
  let lastSyncedAt = null;
  let flushTimer = null;
  let retryTimer = null;
  let flushing = false;

  const isOnline = () => {
    if (manualOnline !== null) return manualOnline;
    if (typeof online === "function") return online();
    try { return typeof navigator === "undefined" ? true : navigator.onLine; } catch { return true; }
  };

  const persist = () => storage.save({ ...st, ackedIds: [...acked] });
  const pending = () => st.log.filter((e) => !acked.has(e.id));
  const sortLog = () => st.log.sort((a, b) => a.seq - b.seq);

  function status() {
    return {
      online: isOnline(),
      pending: pending().length,
      gameId: st.gameId,
      serverSeq: st.hwm,
      lastError,
      lastSyncedAt,
    };
  }
  const emit = () => { onChange(); onStatus(status()); };

  async function init() {
    const saved = await storage.load();
    if (saved) {
      st = { gameId: null, log: [], groups: [], ackedIds: [], hwm: 0, seqCounter: 0, ...saved };
      acked = new Set(st.ackedIds || []);
      delete st.ackedIds;
      sortLog();
    }
    if (installListeners) {
      window.addEventListener("online", () => { manualOnline = null; reconcile(); });
      window.addEventListener("offline", () => { emit(); });
    }
    emit();
    if (isOnline()) await reconcile();
    return status();
  }

  /** Add one user action (1+ events) to the log: assign id+seq, persist, sync. */
  function commit(events) {
    const ids = [];
    for (const e of events) {
      const env = { ...e, id: uuid(), seq: ++st.seqCounter };
      st.log.push(env);
      ids.push(env.id);
    }
    st.groups.push(ids);
    sortLog();
    persist();
    emit();
    scheduleFlush();
    return ids;
  }

  /** Remove the most recent action, but only if none of it has been synced. */
  function undo() {
    const last = st.groups[st.groups.length - 1];
    if (!last) return false;
    if (last.some((id) => acked.has(id))) return false; // can't un-send the server
    st.groups.pop();
    const drop = new Set(last);
    st.log = st.log.filter((e) => !drop.has(e.id));
    st.seqCounter = st.log.reduce((m, e) => Math.max(m, e.seq), st.hwm);
    persist();
    emit();
    return true;
  }

  function getLog() { return [...st.log].sort((a, b) => a.seq - b.seq); }

  function scheduleFlush() {
    if (!autoFlush) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, flushDelay);
  }

  async function api(method, pathPart, body) {
    if (!fetchImpl) throw new Error("no fetch available");
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (personId) headers["X-Person-Id"] = personId;
    const res = await fetchImpl(baseUrl + pathPart, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function ensureGame() {
    if (st.gameId) return st.gameId;
    const r = await api("POST", "/games", { setup });
    st.gameId = r.id;
    await persist();
    return st.gameId;
  }

  /** Push still-unsynced events to the server. */
  async function flush() {
    if (flushing) return;
    if (!isOnline()) { emit(); return; }
    flushing = true;
    try {
      await ensureGame();
      const toPush = pendingToPush(st.log, acked);
      if (toPush.length) {
        const r = await api("POST", `/games/${st.gameId}/events`, { events: toPush });
        const seqById = new Map((r.appended || []).map((a) => [a.id, a.seq]));
        for (const e of st.log) {
          if (seqById.has(e.id)) { e.seq = seqById.get(e.id); acked.add(e.id); }
        }
        st.hwm = Math.max(st.hwm, r.serverSeq || 0);
        st.seqCounter = Math.max(st.seqCounter, st.hwm);
        sortLog();
        await persist();
      }
      lastError = null;
      lastSyncedAt = now();
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      if (autoFlush && pending().length) scheduleRetry();
    } finally {
      flushing = false;
      emit();
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (isOnline()) flush(); }, 3000);
  }

  /** Pull the authoritative remote log, merge, then push anything still pending. */
  async function reconcile() {
    if (!isOnline()) { emit(); return; }
    try {
      if (!st.gameId) { await flush(); return; }
      const r = await api("GET", `/games/${st.gameId}/events?since=0`);
      const remote = r.events || [];
      st.log = mergeLogs(st.log, remote);
      acked = new Set(remote.map((e) => e.id));
      st.hwm = highWaterMark(remote);
      st.seqCounter = Math.max(st.seqCounter, highWaterMark(st.log));
      sortLog();
      await persist();
      lastError = null;
      emit();
      await flush();
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      emit();
    }
  }

  function setOnline(b) {
    manualOnline = b;
    if (b) reconcile();
    else emit();
  }

  return {
    init, commit, undo, getLog, status, reconcile, setOnline,
    flushNow: flush,
    get gameId() { return st.gameId; },
  };
}

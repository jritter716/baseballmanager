import http from "http";
import fs from "fs";
import path from "path";
import { GameStore } from "./store";
import { IdentityStore } from "./identity";
import { TeamId, PersonId, Principal, ResourceRef, canRead, canWrite } from "./access";
import { EventEnvelope } from "./sync";
import { apply, initialState } from "./reducer";
import { defaultRunnerMoves } from "./defaults";
import { GameEvent, RunnerMove } from "./types";

let store = new GameStore();
let identity = new IdentityStore();
const subscribers = new Map<string, Set<http.ServerResponse>>();

function subs(id: string): Set<http.ServerResponse> {
  let s = subscribers.get(id);
  if (!s) { s = new Set(); subscribers.set(id, s); }
  return s;
}

function sse(res: http.ServerResponse, frame: { id?: number; event: string; data: unknown }) {
  if (frame.id !== undefined) res.write(`id: ${frame.id}\n`);
  res.write(`event: ${frame.event}\n`);
  res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
}

/** Push newly appended events + a fresh scoreboard to all followers of a game. */
function broadcast(id: string, appended: EventEnvelope[]) {
  const set = subscribers.get(id);
  if (!set || set.size === 0) return;
  const board = store.scoreboard(id);
  for (const res of set) {
    for (const ev of appended) sse(res, { id: ev.seq, event: "play", data: ev });
    sse(res, { event: "state", data: board });
  }
}

function csvExport(id: string): string {
  const rec = store.get(id)!;
  let s = initialState(rec.setup);
  const rows = [["seq", "inning", "half", "batter", "pitcher", "outcome", "runs"].join(",")];
  for (const e of rec.events) {
    if (e.type === "pa_result") {
      const moves: RunnerMove[] = e.runners ?? defaultRunnerMoves(e.outcome, s.bases, e.batter);
      const runs = moves.filter((m) => m.to === "home").length;
      rows.push([e.seq, s.inning, s.half, e.batter, e.pitcher, e.outcome, runs].join(","));
    }
    s = apply(s, e as GameEvent);
  }
  return rows.join("\n");
}

// --- static file serving (the PWA app shell, served same-origin as the API) ---

const STATIC_DIR =
  process.env.STATIC_DIR || path.join(__dirname, "..", "..", "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Serve a file from STATIC_DIR. Returns true if it handled the response. */
async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const rel = pathname === "/" ? "setup.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = path.resolve(STATIC_DIR, rel);
  // Path-traversal guard: the resolved path must stay inside STATIC_DIR.
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) return false;
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
    };
    // The service worker and HTML must not be served stale, or updates won't land.
    if (ext === ".html" || rel === "sw.js") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function cors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID, X-Person-Id");
}

// --- access enforcement (canRead/canWrite at the boundary) ---
// Phase-0 stub auth: the acting person comes from the `X-Person-Id` header
// (fetch) or `?personId=` query (EventSource can't set headers). Replace with a
// real session/login source later; the decision layer (access.ts) stays the same.
function principalFromReq(req: http.IncomingMessage, url: URL): Principal | null {
  const pid = (req.headers["x-person-id"] as string) || url.searchParams.get("personId") || "";
  return pid ? identity.resolvePrincipal(pid as unknown as PersonId) : null;
}
/** The team whose stream a game belongs to (the home team owns it). */
function ownerTeamId(gameId: string): TeamId | undefined {
  const rec = store.get(gameId);
  return (rec?.setup.homeTeamId ?? rec?.setup.awayTeamId) as unknown as TeamId | undefined;
}
const allowRead = (p: Principal | null, r: ResourceRef) => !!p && canRead(p, r);
const allowWrite = (p: Principal | null, r: ResourceRef) => !!p && canWrite(p, r);
function forbid(res: http.ServerResponse) { return json(res, 403, { error: "forbidden" }); }

function json(res: http.ServerResponse, code: number, body: unknown) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function startServer(port: number, opts: { storeFile?: string; identityFile?: string } = {}): http.Server {
  // Durable when a log file is given; otherwise in-memory (tests/ephemeral).
  if (opts.storeFile) store = new GameStore({ file: opts.storeFile });
  if (opts.identityFile) identity = new IdentityStore({ file: opts.identityFile });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["games", "<id>", "events"]
      const method = req.method || "GET";

      if (method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

      const principal = principalFromReq(req, url);

      // GET /persons  -> DEV STUB for the "acting as" picker (replace with real
      // auth). Lists names so the UI can choose who you are before login exists.
      if (method === "GET" && parts.length === 1 && parts[0] === "persons") {
        return json(res, 200, { persons: identity.listPersons().map((p) => ({ id: p.id, name: p.name, isOrgAdmin: !!p.isOrgAdmin })) });
      }

      // GET /games  -> list only the games this principal may read.
      if (method === "GET" && parts.length === 1 && parts[0] === "games") {
        const games = store.list().filter((g) =>
          allowRead(principal, { kind: "GameEventStream", teamId: ownerTeamId(g.id) }));
        return json(res, 200, { games });
      }

      // GET /teams  -> only teams this principal is affiliated with.
      if (method === "GET" && parts.length === 1 && parts[0] === "teams") {
        const teams = identity.listTeams().filter((t) =>
          allowRead(principal, { kind: "TeamRoster", teamId: t.id }));
        return json(res, 200, { teams });
      }
      // GET /teams/:id/roster  -> a team's roster (stable player ids)
      if (method === "GET" && parts[0] === "teams" && parts[1] && parts[2] === "roster") {
        const teamId = parts[1] as unknown as TeamId;
        if (!allowRead(principal, { kind: "TeamRoster", teamId })) return forbid(res);
        return json(res, 200, { roster: identity.rosterOf(teamId) });
      }

      // POST /games  -> create (a coach/scorer of the home team, or org admin)
      if (method === "POST" && parts.length === 1 && parts[0] === "games") {
        const body = await readBody(req);
        if (!body.setup) return json(res, 400, { error: "setup required" });
        const teamId = (body.setup.homeTeamId ?? body.setup.awayTeamId) as unknown as TeamId | undefined;
        if (!allowWrite(principal, { kind: "GameEventStream", teamId })) return forbid(res);
        const rec = store.create(body.setup);
        return json(res, 201, { id: rec.id });
      }

      if (parts[0] === "games" && parts[1]) {
        const id = parts[1];
        const sub = parts[2];
        const streamRef: ResourceRef = { kind: "GameEventStream", teamId: ownerTeamId(id) };

        // POST /games/:id/events  -> idempotent append + broadcast
        if (method === "POST" && sub === "events") {
          if (!allowWrite(principal, streamRef)) return forbid(res);
          const body = await readBody(req);
          const incoming = (body.events || []) as Array<GameEvent & { id?: string }>;
          const appended = store.append(id, incoming, { actor: principal!.personId });
          if (appended.length) broadcast(id, appended);
          return json(res, 200, {
            appended: appended.map((e) => ({ id: e.id, seq: e.seq })),
            serverSeq: store.scoreboard(id).serverSeq,
          });
        }

        // Everything else on a game is a read of its stream/derived views.
        if (method === "GET" && (sub === "events" || sub === "state" || sub === "export.json" || sub === "export.csv" || sub === "stream")) {
          if (!store.get(id)) return json(res, 404, { error: "no such game" });
          if (!allowRead(principal, streamRef)) return forbid(res);
        }

        // GET /games/:id/events?since=N
        if (method === "GET" && sub === "events") {
          const since = Number(url.searchParams.get("since") || 0);
          return json(res, 200, { events: store.since(id, since), serverSeq: store.scoreboard(id).serverSeq });
        }

        // GET /games/:id/state
        if (method === "GET" && sub === "state") {
          return json(res, 200, store.view(id));
        }

        // GET /games/:id/export.json | export.csv
        if (method === "GET" && sub === "export.json") {
          const rec = store.get(id)!;
          return json(res, 200, { setup: rec.setup, events: rec.events });
        }
        if (method === "GET" && sub === "export.csv") {
          cors(res);
          res.writeHead(200, { "Content-Type": "text/csv" });
          return res.end(csvExport(id));
        }

        // GET /games/:id/stream  -> SSE follower feed with resume
        if (method === "GET" && sub === "stream") {
          cors(res);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write("retry: 3000\n\n");
          // resume: replay anything the follower missed since their last id
          const lastId = Number(req.headers["last-event-id"] || url.searchParams.get("lastEventId") || 0);
          for (const ev of store.since(id, lastId)) sse(res, { id: ev.seq, event: "play", data: ev });
          sse(res, { event: "state", data: store.scoreboard(id) });
          subs(id).add(res);
          req.on("close", () => subs(id).delete(res));
          return;
        }
      }

      // Fall through to the static app shell for any other GET.
      if (method === "GET" && (await serveStatic(url.pathname, res))) return;

      json(res, 404, { error: "not found" });
    } catch (err: any) {
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });
  server.listen(port);
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const storeFile = process.env.STORE_FILE || path.join(__dirname, "..", "..", "data", "games.jsonl");
  const identityFile = process.env.IDENTITY_FILE || path.join(__dirname, "..", "..", "data", "identity.jsonl");
  startServer(port, { storeFile, identityFile });
  // eslint-disable-next-line no-console
  console.log(`scoring server listening on :${port} (store: ${storeFile})`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { store.close(); identity.close(); process.exit(0); });
  }
}

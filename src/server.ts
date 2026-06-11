import http from "http";
import fs from "fs";
import path from "path";
import { GameStore } from "./store";
import { EventEnvelope } from "./sync";
import { apply, initialState } from "./reducer";
import { defaultRunnerMoves } from "./defaults";
import { GameEvent, RunnerMove } from "./types";

const store = new GameStore();
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
  const rel = pathname === "/" ? "scoring-app.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
}

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

export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["games", "<id>", "events"]
      const method = req.method || "GET";

      if (method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

      // POST /games  -> create
      if (method === "POST" && parts.length === 1 && parts[0] === "games") {
        const body = await readBody(req);
        if (!body.setup) return json(res, 400, { error: "setup required" });
        const rec = store.create(body.setup);
        return json(res, 201, { id: rec.id });
      }

      if (parts[0] === "games" && parts[1]) {
        const id = parts[1];
        const sub = parts[2];

        // POST /games/:id/events  -> idempotent append + broadcast
        if (method === "POST" && sub === "events") {
          const body = await readBody(req);
          const incoming = (body.events || []) as Array<GameEvent & { id?: string }>;
          const appended = store.append(id, incoming);
          if (appended.length) broadcast(id, appended);
          return json(res, 200, {
            appended: appended.map((e) => ({ id: e.id, seq: e.seq })),
            serverSeq: store.scoreboard(id).serverSeq,
          });
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
          if (!store.get(id)) return json(res, 404, { error: "no such game" });
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
  startServer(port);
  // eslint-disable-next-line no-console
  console.log(`scoring server listening on :${port}`);
}

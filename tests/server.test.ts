import http from "http";
import { startServer } from "../src/server";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 8911;
const server = startServer(PORT);

function req(method: string, path: string, body?: unknown): Promise<{ status?: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: "localhost", port: PORT, path, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null })); }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function lineup(p: string) {
  const pos = ["SS", "CF", "1B", "C", "3B", "2B", "RF", "LF", "P"] as const;
  return { teamId: p, battingOrder: pos.map((x, i) => ({ playerId: p + (i + 1), position: x })) };
}
const setup = { away: lineup("m"), home: lineup("h") };

const x1 = { id: "x1", type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single" };
const x2 = { id: "x2", type: "pa_result", batter: "m2", pitcher: "h9", outcome: "home_run" };
const x3 = { id: "x3", type: "pa_result", batter: "m3", pitcher: "h9", outcome: "home_run" };

async function main() {
  const created = await req("POST", "/games", { setup });
  const id = created.body.id;
  eq(typeof id, "string", "game created with id");

  const a1 = await req("POST", `/games/${id}/events`, { events: [x1, x2] });
  eq(a1.body.appended.length, 2, "first sync appends 2");
  eq(a1.body.appended[0].seq, 1, "server assigns seq 1");

  const dup = await req("POST", `/games/${id}/events`, { events: [x1, x2] });
  eq(dup.body.appended.length, 0, "resend is idempotent");

  const st = await req("GET", `/games/${id}/state`);
  eq(st.body.scoreboard.score.away, 2, "authoritative state: away 2");
  eq(st.body.box.batting.m2.hr, 1, "authoritative state: box derived");

  // live SSE follower
  let sse = "";
  const stream = http.get({ host: "localhost", port: PORT, path: `/games/${id}/stream` }, (res) => res.on("data", (d) => (sse += d)));
  await delay(250);
  await req("POST", `/games/${id}/events`, { events: [x3] });
  await delay(250);
  stream.destroy();
  eq(/event: play/.test(sse), true, "follower received a play frame");
  eq(/"id":"x3"/.test(sse), true, "follower received the live x3 event");
  eq(/event: state/.test(sse), true, "follower received a scoreboard frame");

  // gap-resume: reconnect with Last-Event-ID = 1, should replay seq 2 and 3
  let resume = "";
  const r2 = http.request({ host: "localhost", port: PORT, path: `/games/${id}/stream`, headers: { "Last-Event-ID": "1" } }, (res) => res.on("data", (d) => (resume += d)));
  r2.end();
  await delay(250);
  r2.destroy();
  const replayed = (resume.match(/event: play/g) || []).length;
  eq(replayed, 2, "resume replays the 2 missed plays (seq > 1)");

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });

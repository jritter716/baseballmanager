import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { startServer } from "../src/server";
import { IdentityStore } from "../src/identity";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- seed an identity the server will enforce against ---
const idFile = path.join(os.tmpdir(), `bb-server-identity-${process.pid}.jsonl`);
try { fs.unlinkSync(idFile); } catch { /* none */ }
const idstore = new IdentityStore({ file: idFile });
const org = idstore.addOrg("Org");
const home = idstore.addTeam(org.id, "Home");
const away = idstore.addTeam(org.id, "Away");
const admin = idstore.addPerson("Admin", true);
const coach = idstore.addPerson("Coach"); idstore.addMembership(coach.id, home.id, "HEAD_COACH");
const scorer = idstore.addPerson("Scorer"); idstore.addMembership(scorer.id, home.id, "SCORER");
const parent = idstore.addPerson("Parent");
const kid = idstore.addRosterPlayer(home.id, "Kid", "1"); idstore.addGuardianship(parent.id, kid.id);
const stranger = idstore.addPerson("Stranger");
idstore.close();

const PORT = 8911;
const server = startServer(PORT, { identityFile: idFile });

function req(method: string, p: string, body?: unknown, personId?: string): Promise<{ status?: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: any = {};
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    if (personId) headers["X-Person-Id"] = personId;
    const r = http.request({ host: "localhost", port: PORT, path: p, method, headers },
      (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null })); });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function lineup(p: string) {
  const pos = ["SS", "CF", "1B", "C", "3B", "2B", "RF", "LF", "P"] as const;
  return { teamId: p, battingOrder: pos.map((x, i) => ({ playerId: p + (i + 1), position: x })) };
}
const setup = { orgId: org.id, awayTeamId: away.id, homeTeamId: home.id, away: lineup("m"), home: lineup("h") };

const x1 = { id: "x1", type: "pa_result", batter: "m1", pitcher: "h9", outcome: "single" };
const x2 = { id: "x2", type: "pa_result", batter: "m2", pitcher: "h9", outcome: "home_run" };
const x3 = { id: "x3", type: "pa_result", batter: "m3", pitcher: "h9", outcome: "home_run" };

async function main() {
  // ---- access enforcement at the boundary ----
  eq((await req("POST", "/games", { setup })).status, 403, "create game without identity -> 403");
  eq((await req("POST", "/games", { setup }, stranger.id)).status, 403, "stranger can't create a game -> 403");

  const created = await req("POST", "/games", { setup }, coach.id); // home-team coach
  const id = created.body.id;
  eq(typeof id, "string", "home-team coach creates the game");

  eq((await req("POST", `/games/${id}/events`, { events: [x1] })).status, 403, "scoring without identity -> 403");
  eq((await req("POST", `/games/${id}/events`, { events: [x1] }, parent.id)).status, 403, "a parent can't score -> 403");
  eq((await req("GET", `/games/${id}/state`, undefined, stranger.id)).status, 403, "stranger can't read the game -> 403");
  eq((await req("GET", `/games/${id}/state`, undefined, parent.id)).status, 200, "affiliated parent CAN read the game");

  // ---- normal scoring by the designated scorer ----
  const a1 = await req("POST", `/games/${id}/events`, { events: [x1, x2] }, scorer.id);
  eq(a1.body.appended.length, 2, "scorer appends 2");
  eq(a1.body.appended[0].seq, 1, "server assigns seq 1");

  const dup = await req("POST", `/games/${id}/events`, { events: [x1, x2] }, scorer.id);
  eq(dup.body.appended.length, 0, "resend is idempotent");

  const st = await req("GET", `/games/${id}/state`, undefined, coach.id);
  eq(st.body.scoreboard.score.away, 2, "authoritative state: away 2");
  eq(st.body.box.batting.m2.hr, 1, "authoritative state: box derived");

  // actor is stamped from the authenticated principal
  const ex = await req("GET", `/games/${id}/export.json`, undefined, admin.id);
  eq(ex.body.events[0].actor, scorer.id, "event actor = the scorer who recorded it");

  // listing is scoped: admin sees the game, stranger sees none
  eq((await req("GET", "/games", undefined, admin.id)).body.games.length >= 1, true, "admin lists the game");
  eq((await req("GET", "/games", undefined, stranger.id)).body.games.length, 0, "stranger lists no games");

  // ---- live SSE follower (identity via ?personId=, as EventSource can't set headers) ----
  let sse = "";
  const stream = http.get({ host: "localhost", port: PORT, path: `/games/${id}/stream?personId=${coach.id}` }, (res) => res.on("data", (d) => (sse += d)));
  await delay(250);
  await req("POST", `/games/${id}/events`, { events: [x3] }, scorer.id);
  await delay(250);
  stream.destroy();
  eq(/event: play/.test(sse), true, "follower received a play frame");
  eq(/"id":"x3"/.test(sse), true, "follower received the live x3 event");
  eq(/event: state/.test(sse), true, "follower received a scoreboard frame");

  // unaffiliated SSE is rejected
  const bad = await req("GET", `/games/${id}/stream?personId=${stranger.id}`);
  eq(bad.status, 403, "stranger can't open the follower stream -> 403");

  // gap-resume with identity
  let resume = "";
  const r2 = http.request({ host: "localhost", port: PORT, path: `/games/${id}/stream?personId=${coach.id}`, headers: { "Last-Event-ID": "1" } }, (res) => res.on("data", (d) => (resume += d)));
  r2.end();
  await delay(250);
  r2.destroy();
  eq((resume.match(/event: play/g) || []).length, 2, "resume replays the 2 missed plays (seq > 1)");

  server.close();
  try { fs.unlinkSync(idFile); } catch { /* none */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });

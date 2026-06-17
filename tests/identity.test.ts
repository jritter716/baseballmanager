// Identity store: persistence/recovery + resolvePrincipal wired to real stored
// people/roster/guardianships, re-validating the §4 rules end-to-end (not from
// hand-built principals but from the store the way the server will use it).
import fs from "fs";
import os from "os";
import path from "path";
import { IdentityStore } from "../src/identity";
import { seedDevOrg } from "../src/seed";
import { canRead, type ResourceRef } from "../src/access";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}

// ---- seed an in-memory org and resolve principals from the store ----
{
  const s = new IdentityStore();
  const d = seedDevOrg(s);
  eq(s.listTeams().length, 2, "two teams seeded");
  eq(s.rosterOf(d.t12.id).length, 9, "12U roster has 9 players");
  eq(s.rosterOf(d.t10.id).length, 9, "10U roster has 9 (8 + Chris's kid)");

  const chris = s.resolvePrincipal(d.chris.id);
  eq(chris.isOrgAdmin, true, "Chris resolves as org admin");
  eq(chris.coachTeams.has(d.t12.id), true, "Chris coaches the 12U");
  eq(chris.guardianTeams.has(d.t10.id), true, "Chris guardians on the 10U (per-team role)");

  const parent = s.resolvePrincipal(d.parent.id);
  eq(parent.isOrgAdmin, false, "parent is not org admin");
  eq(parent.guardianPlayerIds.has(d.roster12[0].id), true, "parent guardians Avery");
  eq(parent.coachTeams.size, 0, "parent coaches nobody");

  const scorer = s.resolvePrincipal(d.scorer.id);
  eq(scorer.scorerTeams.has(d.t12.id), true, "scorer is a designated scorer on the 12U");

  // §4 spot-checks, now driven by store-resolved principals
  const dev = (pl: any, t: any): ResourceRef => ({ kind: "PlayerDevelopment", teamId: t, subjectPlayerId: pl });
  const signs = (t: any): ResourceRef => ({ kind: "TeamSigns", teamId: t });
  eq(canRead(parent, dev(d.roster12[0].id, d.t12.id)), true, "parent reads own kid's dev (store-resolved)");
  eq(canRead(parent, dev(d.roster12[1].id, d.t12.id)), false, "PRIVACY: parent can't read another kid's dev (store-resolved)");
  eq(canRead(parent, signs(d.t12.id)), false, "PRIVACY: parent not shown signs (store-resolved)");
  eq(canRead(s.resolvePrincipal(d.coach.id), signs(d.t12.id)), true, "assistant coach reads the signs");
}

// ---- persistence: a fresh store on the same file recovers everything ----
{
  const file = path.join(os.tmpdir(), `bb-identity-${process.pid}.jsonl`);
  try { fs.unlinkSync(file); } catch { /* none */ }

  const a = new IdentityStore({ file });
  const d = seedDevOrg(a);
  const chrisStanding = JSON.stringify([...a.resolvePrincipal(d.chris.id).coachTeams]);
  a.close();

  const b = new IdentityStore({ file }); // "restart"
  eq(b.listTeams().length, 2, "teams recovered after restart");
  eq(b.rosterOf(d.t12.id).length, 9, "roster recovered after restart");
  eq(JSON.stringify([...b.resolvePrincipal(d.chris.id).coachTeams]), chrisStanding, "Chris's resolved standing identical after restart");
  eq(b.resolvePrincipal(d.parent.id).guardianPlayerIds.has(d.roster12[0].id), true, "guardianship recovered after restart");

  // corrupt trailing line tolerated
  fs.appendFileSync(file, '{"k":"team","tea');
  const c = new IdentityStore({ file });
  eq(c.listTeams().length, 2, "recovers despite a corrupt trailing line");
  c.close();
  try { fs.unlinkSync(file); } catch { /* none */ }
}

// ---- in-memory mode writes nothing ----
{
  const memFile = path.join(os.tmpdir(), `bb-identity-mem-${process.pid}.jsonl`);
  try { fs.unlinkSync(memFile); } catch { /* none */ }
  const s = new IdentityStore();
  seedDevOrg(s);
  eq(fs.existsSync(memFile), false, "in-memory identity store writes no file");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

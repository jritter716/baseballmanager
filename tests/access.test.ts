// Clutch access layer: identity resolution + canRead/canWrite, with the §4
// privacy negatives the brief calls non-negotiable (a kid's development data and
// a team's signs are the sensitive assets; deny-by-default everywhere else).
import {
  resolvePrincipal, canRead, canWrite,
  type Principal, type ResourceRef,
  type PersonId, type TeamId, type AccessPlayerId,
} from "../src/access";

let passed = 0, failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (a === b) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${b}, got ${a}`); }
}
const id = <T>(s: string) => s as unknown as T;
const T12 = id<TeamId>("team-12u"), T10 = id<TeamId>("team-10u");
const kidA = id<AccessPlayerId>("playerA"), kidB = id<AccessPlayerId>("playerB"), kid10 = id<AccessPlayerId>("player10");

// ---- principals across the per-team role matrix ----
const chris = resolvePrincipal(id<PersonId>("chris"), { isOrgAdmin: true,
  memberships: [{ personId: id<PersonId>("chris"), teamId: T12, role: "HEAD_COACH" }], roster: [], guardianships: [] });
const coach12 = resolvePrincipal(id<PersonId>("coach12"), {
  memberships: [{ personId: id<PersonId>("coach12"), teamId: T12, role: "HEAD_COACH" }], roster: [], guardianships: [] });
const scorer12 = resolvePrincipal(id<PersonId>("scorer12"), {
  memberships: [{ personId: id<PersonId>("scorer12"), teamId: T12, role: "SCORER" }], roster: [], guardianships: [] });
const parentA = resolvePrincipal(id<PersonId>("parentA"), {
  memberships: [], roster: [{ playerId: kidA, teamId: T12 }], guardianships: [{ personId: id<PersonId>("parentA"), playerId: kidA }] });
const playerA = resolvePrincipal(id<PersonId>("personA"), {
  memberships: [], roster: [{ playerId: kidA, teamId: T12, personId: id<PersonId>("personA") }], guardianships: [] });
const playerB = resolvePrincipal(id<PersonId>("personB"), {
  memberships: [], roster: [{ playerId: kidB, teamId: T12, personId: id<PersonId>("personB") }], guardianships: [] });
// coach on 12U AND parent of a kid on 10U — the per-team-roles case.
const dual = resolvePrincipal(id<PersonId>("dual"), {
  memberships: [{ personId: id<PersonId>("dual"), teamId: T12, role: "ASSISTANT_COACH" }],
  roster: [{ playerId: kid10, teamId: T10 }], guardianships: [{ personId: id<PersonId>("dual"), playerId: kid10 }] });
const stranger = resolvePrincipal(id<PersonId>("stranger"), { memberships: [], roster: [], guardianships: [] });

const dev = (pl: AccessPlayerId, t: TeamId): ResourceRef => ({ kind: "PlayerDevelopment", teamId: t, subjectPlayerId: pl });
const signs = (t: TeamId): ResourceRef => ({ kind: "TeamSigns", teamId: t });
const stats = (pl: AccessPlayerId, t: TeamId): ResourceRef => ({ kind: "PlayerGameStats", teamId: t, subjectPlayerId: pl });
const sched = (t: TeamId): ResourceRef => ({ kind: "TeamSchedule", teamId: t });
const notes = (t: TeamId): ResourceRef => ({ kind: "CoachNotes", teamId: t });
const corpus: ResourceRef = { kind: "PhilosophyCorpus" };
const stream = (t: TeamId): ResourceRef => ({ kind: "GameEventStream", teamId: t });

// ---- PlayerDevelopment: the sensitive asset ----
eq(canRead(chris, dev(kidA, T12)), true, "org admin reads any development data");
eq(canRead(coach12, dev(kidA, T12)), true, "team coach reads his player's development");
eq(canRead(parentA, dev(kidA, T12)), true, "guardian reads own kid's development");
eq(canRead(playerA, dev(kidA, T12)), true, "player reads his own development");
eq(canRead(parentA, dev(kidB, T12)), false, "PRIVACY: parent A must NOT see kid B's development");
eq(canRead(playerB, dev(kidA, T12)), false, "PRIVACY: a teammate must NOT see another kid's development");

// ---- TeamSigns: competitive secret ----
eq(canRead(coach12, signs(T12)), true, "coach sees his team's signs");
eq(canRead(playerA, signs(T12)), true, "rostered player sees his team's signs");
eq(canRead(parentA, signs(T12)), false, "PRIVACY: a parent is not shown the signs (default)");
eq(canRead(playerA, signs(T10)), false, "player does not see another team's signs");

// ---- broadly-visible team info ----
eq(canRead(parentA, sched(T12)), true, "affiliated parent reads the schedule");
eq(canRead(stranger, sched(T12)), false, "unaffiliated person reads nothing");

// ---- box-score stats + the teammates toggle ----
eq(canRead(playerB, stats(kidA, T12)), true, "teammate sees box-score stats (toggle on)");
eq(canRead(parentA, stats(kidB, T12)), false, "a parent does not see another kid's box score");

// ---- coach-only surfaces ----
eq(canRead(coach12, notes(T12)), true, "coach reads coach notes");
eq(canRead(parentA, notes(T12)), false, "parent does not read coach notes");
eq(canRead(coach12, corpus), true, "any coach reads the philosophy corpus");
eq(canRead(parentA, corpus), false, "non-coach does not read the corpus");

// ---- per-team roles: same person, different standing per team ----
eq(canRead(dual, dev(kid10, T10)), true, "dual-role: reads his own kid's dev on the 10U (as guardian)");
eq(canRead(dual, notes(T12)), true, "dual-role: reads coach notes on the 12U (as coach)");
eq(canRead(dual, notes(T10)), false, "dual-role: NOT a coach on the 10U -> no coach notes there");
eq(canRead(dual, signs(T10)), false, "dual-role: a parent on the 10U is not shown its signs");

// ---- writes ----
eq(canWrite(scorer12, stream(T12)), true, "designated scorer writes the game stream");
eq(canWrite(coach12, stream(T12)), true, "coach writes the game stream");
eq(canWrite(parentA, stream(T12)), false, "a parent cannot score the game");
eq(canWrite(coach12, signs(T12)), true, "coach writes his team's signs");
eq(canWrite(playerA, dev(kidA, T12)), false, "a player cannot write his own development tags");
eq(canWrite(coach12, stats(kidA, T12)), false, "stats are derived, never written directly");
eq(canWrite(coach12, { kind: "GameResult", teamId: T12 }), false, "results are derived, never written directly");
eq(canWrite(coach12, corpus), true, "any coach contributes to the corpus");
eq(canWrite(parentA, corpus), false, "a non-coach cannot write the corpus");
eq(canWrite(chris, { kind: "OrgAdmin" }), true, "org admin can do anything");
eq(canRead(stranger, { kind: "OrgAdmin" }), false, "deny-by-default for unaffiliated");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

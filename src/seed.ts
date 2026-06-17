/**
 * Seed a stub Clutch org into an IdentityStore. This is the "stubbed identity"
 * for Phase 0 — real data to resolve Principals against and to build games from
 * (real roster PlayerIds), until a real login/auth source exists.
 *
 *   npm run seed        # writes data/identity.jsonl (skips if already seeded)
 */
import fs from "fs";
import path from "path";
import { IdentityStore } from "./identity";

export function seedDevOrg(store: IdentityStore) {
  const org = store.addOrg("Clutch");
  const t12 = store.addTeam(org.id, "Clutch 12U");
  const t10 = store.addTeam(org.id, "Clutch 10U");

  const chris = store.addPerson("Chris Sorenson", true);          // org admin + head coach 12U + parent on 10U
  store.addMembership(chris.id, t12.id, "HEAD_COACH");
  const coach = store.addPerson("Coach Dana");
  store.addMembership(coach.id, t12.id, "ASSISTANT_COACH");
  const scorer = store.addPerson("Scorer Sam");
  store.addMembership(scorer.id, t12.id, "SCORER");

  const names12 = ["Avery P.", "Mason T.", "Diego R.", "Liam K.", "Noah B.", "Eli W.", "Caleb M.", "Owen S.", "Jack D."];
  const roster12 = names12.map((n, i) => store.addRosterPlayer(t12.id, n, String(i + 1)));

  const names10 = ["Tyler M.", "Sam K.", "Marcus D.", "Cole R.", "Drew L.", "Ben A.", "Luca P.", "Ivan G."];
  const roster10 = names10.map((n, i) => store.addRosterPlayer(t10.id, n, String(i + 1)));
  const chrisKid = store.addRosterPlayer(t10.id, "Sorenson Jr.", "7");
  store.addGuardianship(chris.id, chrisKid.id);                   // Chris guardians his kid on the 10U

  const parent = store.addPerson("Parent Pat");                   // parent of Avery on the 12U
  store.addGuardianship(parent.id, roster12[0].id);

  return { org, t12, t10, chris, coach, scorer, parent, roster12, roster10, chrisKid };
}

if (require.main === module) {
  const file = process.env.IDENTITY_FILE || path.join(__dirname, "..", "..", "data", "identity.jsonl");
  const store = new IdentityStore({ file });
  if (store.listTeams().length > 0) {
    // eslint-disable-next-line no-console
    console.log(`identity store already seeded (${store.listTeams().length} teams) at ${file} — skipping`);
  } else {
    const s = seedDevOrg(store);
    // eslint-disable-next-line no-console
    console.log(`seeded Clutch org at ${file}\n  12U=${s.t12.id}\n  10U=${s.t10.id}\n  admin(Chris)=${s.chris.id}`);
  }
  store.close();
}

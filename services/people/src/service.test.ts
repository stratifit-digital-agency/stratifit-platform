/**
 * People service unit tests (Stage 2.16).
 *
 * In-memory fake repository mirroring the real Drizzle adapter semantics:
 * UNIQUE(org, aiCreator) on profiles (retire-before-insert), UNIQUE
 * publication_version_id idempotency, per-org handle uniqueness on
 * ai_creators. Covers the approved matrix: chain creation, cross-org/
 * inactive-parent rejection, lifecycle transitions, rights vacuous-pass and
 * fail-closed fake-port behavior, capability gating, snapshot idempotency,
 * republish history retention, unpublish idempotency.
 */
import { describe, expect, it } from "vitest";
import { createPeopleService } from "./service";
import { createDrizzlePeopleRepository } from "./repository";
import type {
  AiCreatorRecord,
  ChainStatus,
  CharacterRecord,
  CreatorProfileRecord,
  DigitalHumanRecord,
  PeoplePrincipal,
  PeopleRepository,
  PeopleTransaction,
  PersonaRecord,
  ProfileSnapshotInput,
} from "./types";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

type Store = {
  dh: DigitalHumanRecord[];
  ch: CharacterRecord[];
  pe: PersonaRecord[];
  ac: AiCreatorRecord[];
  pr: CreatorProfileRecord[];
  /** Seeded publication-version rows for the mediation org re-check (freeze fix 2). */
  pv: { publicationId: string; publicationVersionId: string; publicationOrgId: string; versionOrgId: string }[];
  audit: Parameters<PeopleTransaction["appendAudit"]>[0][];
};

const now = () => new Date();
const seq = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

const makeStore = (): Store => ({ dh: [], ch: [], pe: [], ac: [], pr: [], pv: [], audit: [] });

const fakeRepo = (store: Store): PeopleRepository & { seedPublication: (publicationOrgId: string, versionOrgId: string, publicationId: string, publicationVersionId: string) => void } => {
  /** Audit sink for the transactional path (assertions inspect it). */
  const repo: PeopleRepository = {
  insertDigitalHuman: async (input) => {
    const row: DigitalHumanRecord = {
      id: seq(), orgId: input.orgId, name: input.name,
      appearanceRefs: [...input.appearanceRefs],
      baseModelVersionRef: input.baseModelVersionRef,
      baseWorkflowVersionRef: input.baseWorkflowVersionRef,
      status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.dh.push(row);
    return row;
  },
  findDigitalHumanById: async (id) => store.dh.find((r) => r.id === id) ?? null,
  listDigitalHumans: async (orgId) => store.dh.filter((r) => r.orgId === orgId),
  setDigitalHumanStatus: async (id, status) => {
    const row = store.dh.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.dh = store.dh.map((r) => (r.id === id ? updated : r));
    return updated;
  },

  insertCharacter: async (input) => {
    const row: CharacterRecord = {
      id: seq(), orgId: input.orgId, digitalHumanId: input.digitalHumanId,
      name: input.name, bio: input.bio, visualRefs: [...input.visualRefs],
      status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.ch.push(row);
    return row;
  },
  findCharacterById: async (id) => store.ch.find((r) => r.id === id) ?? null,
  listCharacters: async (orgId) => store.ch.filter((r) => r.orgId === orgId),
  setCharacterStatus: async (id, status) => {
    const row = store.ch.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.ch = store.ch.map((r) => (r.id === id ? updated : r));
    return updated;
  },

  insertPersona: async (input) => {
    const row: PersonaRecord = {
      id: seq(), orgId: input.orgId, characterId: input.characterId, name: input.name,
      personality: input.personality, interests: [...input.interests],
      capabilities: [...input.capabilities], languages: [...input.languages],
      behaviorConfig: input.behaviorConfig, status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.pe.push(row);
    return row;
  },
  findPersonaById: async (id) => store.pe.find((r) => r.id === id) ?? null,
  listPersonas: async (orgId) => store.pe.filter((r) => r.orgId === orgId),
  setPersonaStatus: async (id, status) => {
    const row = store.pe.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.pe = store.pe.map((r) => (r.id === id ? updated : r));
    return updated;
  },

  insertAiCreator: async (input) => {
    const row: AiCreatorRecord = {
      id: seq(), orgId: input.orgId, personaId: input.personaId, handle: input.handle,
      displayName: input.displayName, capabilities: [...input.capabilities],
      contentCategories: [...input.contentCategories],
      communicationConfig: input.communicationConfig, isAi: true,
      status: "draft", createdAt: now(), updatedAt: now(),
    };
    store.ac.push(row);
    return row;
  },
  findAiCreatorById: async (id) => store.ac.find((r) => r.id === id) ?? null,
  findAiCreatorByHandle: async (orgId, handle) =>
    store.ac.find((r) => r.orgId === orgId && r.handle === handle) ?? null,
  listAiCreators: async (orgId) => store.ac.filter((r) => r.orgId === orgId),
  setAiCreatorStatus: async (id, status) => {
    const row = store.ac.find((r) => r.id === id);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.ac = store.ac.map((r) => (r.id === id ? updated : r));
    return updated;
  },

  findCurrentProfile: async (orgId, aiCreatorId) =>
    store.pr.find((r) => r.orgId === orgId && r.aiCreatorId === aiCreatorId) ?? null,
  findProfileByVersionId: async (publicationVersionId) =>
    store.pr.find((r) => r.publicationVersionId === publicationVersionId) ?? null,
  findActiveProfileByHandle: async (handle) =>
    store.pr.find((r) => r.handle === handle && r.status === "active") ?? null,
  findActiveProfileByCreatorId: async (aiCreatorId) =>
    store.pr.find((r) => r.aiCreatorId === aiCreatorId && r.status === "active") ?? null,
  insertProfile: async (input) => {
    if (store.pr.some((r) => r.publicationVersionId === input.publicationVersionId)) {
      throw new Error("unique violation: creator_profiles_publication_version_unique");
    }
    // Partial unique (live statuses only) — mirrors the DB: historical
    // 'unpublished' rows do not hold the (org, creator) slot.
    if (
      store.pr.some(
        (r) => r.orgId === input.orgId && r.aiCreatorId === input.aiCreatorId && r.status !== "unpublished",
      )
    ) {
      throw new Error("unique violation: creator_profiles_org_creator_unique");
    }
    if (
      store.pr.some((r) => r.orgId === input.orgId && r.handle === input.handle && r.status !== "unpublished")
    ) {
      throw new Error("unique violation: creator_profiles_org_handle_unique");
    }
    const row: CreatorProfileRecord = {
      id: seq(), orgId: input.orgId, aiCreatorId: input.aiCreatorId,
      publicationId: input.publicationId, publicationVersionId: input.publicationVersionId,
      handle: input.handle, displayName: input.displayName, bio: input.bio,
      personalitySnapshot: input.personalitySnapshot, interestsSnapshot: [...input.interestsSnapshot],
      avatarRef: input.avatarRef, posterRef: input.posterRef,
      messagingEnabled: input.messagingEnabled, status: "active", createdAt: now(), updatedAt: now(),
    };
    store.pr.push(row);
    return row;
  },
  retireProfile: async (profileId) => {
    const row = store.pr.find((r) => r.id === profileId)!;
    const updated = { ...row, status: "unpublished" as const, updatedAt: now() };
    store.pr = store.pr.map((r) => (r.id === profileId ? updated : r));
    return updated;
  },
  setProfileStatus: async (profileId, status) => {
    const row = store.pr.find((r) => r.id === profileId);
    if (!row) return null;
    const updated = { ...row, status, updatedAt: now() };
    store.pr = store.pr.map((r) => (r.id === profileId ? updated : r));
    return updated;
  },
  listActiveProfiles: async () => store.pr.filter((r) => r.status === "active"),
  listProfilesByOrg: async (orgId) => store.pr.filter((r) => r.orgId === orgId),
  };
  // D2.4-1 fake: run work over the SAME store; tx.appendAudit records into
  // store.audit so unit tests can assert the frozen action set.
  const txView: PeopleTransaction = {
    insertDigitalHuman: repo.insertDigitalHuman!,
    findDigitalHumanById: repo.findDigitalHumanById!,
    setDigitalHumanStatus: repo.setDigitalHumanStatus!,
    insertCharacter: repo.insertCharacter!,
    findCharacterById: repo.findCharacterById!,
    setCharacterStatus: repo.setCharacterStatus!,
    insertPersona: repo.insertPersona!,
    findPersonaById: repo.findPersonaById!,
    setPersonaStatus: repo.setPersonaStatus!,
    insertAiCreator: repo.insertAiCreator!,
    findAiCreatorById: repo.findAiCreatorById!,
    findAiCreatorByHandle: repo.findAiCreatorByHandle!,
    setAiCreatorStatus: repo.setAiCreatorStatus!,
    findCurrentProfile: repo.findCurrentProfile!,
    findProfileByVersionId: repo.findProfileByVersionId!,
    insertProfile: repo.insertProfile!,
    retireProfile: repo.retireProfile!,
    findPublicationVersionOrg: async (publicationId, publicationVersionId) => {
      const row = store.pv.find((r) => r.publicationId === publicationId && r.publicationVersionId === publicationVersionId);
      return row ? { versionOrgId: row.versionOrgId, publicationOrgId: row.publicationOrgId } : null;
    },
    appendAudit: async (entry) => {
      store.audit.push(entry);
    },
  };
  return {
    ...repo,
    runInTransaction: async <T>(work: (tx: PeopleTransaction) => Promise<T>) => work(txView),
    seedPublication: (publicationOrgId: string, versionOrgId: string, publicationId: string, publicationVersionId: string) => {
      // A publication lives in exactly one org — replace any prior row.
      store.pv = store.pv.filter((r) => !(r.publicationId === publicationId && r.publicationVersionId === publicationVersionId));
      store.pv.push({ publicationId, publicationVersionId, publicationOrgId, versionOrgId });
    },
  };
};

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

const admin = (orgId: string): PeoplePrincipal => ({
  operatorId: "eeeeeeee-0000-4000-8000-0000000000aa",
  orgId,
  capabilities: ["people.manage", "people.read", "production.publish", "admin.permissions", "audit.read"],
});
const readOnly = (orgId: string): PeoplePrincipal => ({
  operatorId: "eeeeeeee-0000-4000-8000-0000000000bb",
  orgId,
  capabilities: ["people.read", "audit.read"],
});
const noCaps = (orgId: string): PeoplePrincipal => ({
  operatorId: "eeeeeeee-0000-4000-8000-0000000000cc",
  orgId,
  capabilities: ["audit.read"],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("people chain authoring (D2.16-1, D2.16-4)", () => {
  it("creates a full chain in one org: dh → character → persona → ai creator", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);

    const dh = await svc.createDigitalHuman(p, { name: "Ava" });
    expect(dh.ok).toBe(true);
    if (!dh.ok) return;
    expect(dh.value.status).toBe("draft");
    expect(dh.value.orgId).toBe(ORG_A);

    const ch = await svc.createCharacter(p, { digitalHumanId: dh.value.id, name: "Ava Prime", bio: "host" });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    expect(ch.value.digitalHumanId).toBe(dh.value.id);

    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "Ava persona" });
    expect(pe.ok).toBe(true);
    if (!pe.ok) return;

    const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "ava-ai", displayName: "Ava AI" });
    expect(ac.ok).toBe(true);
    if (!ac.ok) return;
    expect(ac.value.handle).toBe("ava-ai");
    expect(ac.value.isAi).toBe(true);
  });

  it("allows a character WITHOUT a digital human (uncast character is legal)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const ch = await svc.createCharacter(admin(ORG_A), { name: "Orphan" });
    expect(ch.ok).toBe(true);
  });

  it("rejects cross-org chain parents (fail closed)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const dhA = await svc.createDigitalHuman(admin(ORG_A), { name: "Ava" });
    if (!dhA.ok) return expect.unreachable();

    const wrong = await svc.createCharacter(admin(ORG_B), { digitalHumanId: dhA.value.id, name: "Evil twin" });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.reason).toBe("cross_org_reference");
  });

  it("rejects missing chain parents (fail closed)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const noChar = await svc.createPersona(admin(ORG_A), { characterId: seq(), name: "X" });
    expect(noChar.ok).toBe(false);
    if (!noChar.ok) expect(noChar.error.reason).toBe("not_found");

    const noPersona = await svc.createAiCreator(admin(ORG_A), { personaId: seq(), handle: "ghost", displayName: "Ghost" });
    expect(noPersona.ok).toBe(false);
    if (!noPersona.ok) expect(noPersona.error.reason).toBe("not_found");
  });

  it("rejects retired parents (inactive_parent) and duplicate handles", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);

    const ch = await svc.createCharacter(p, { name: "R" });
    if (!ch.ok) return expect.unreachable();
    await svc.changeStatus(p, "character", { id: ch.value.id, status: "active" });
    const retired = await svc.changeStatus(p, "character", { id: ch.value.id, status: "retired" });
    if (!retired.ok) return expect.unreachable();

    const persona = await svc.createPersona(p, { characterId: ch.value.id, name: "X" });
    expect(persona.ok).toBe(false);
    if (!persona.ok) expect(persona.error.reason).toBe("inactive_parent");

    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "X" });
    expect(pe.ok).toBe(false); // same, character is retired

    const dh = await svc.createDigitalHuman(p, { name: "K" });
    if (!dh.ok) return expect.unreachable();
    await svc.changeStatus(p, "digital_human", { id: dh.value.id, status: "active" });
    await svc.changeStatus(p, "digital_human", { id: dh.value.id, status: "retired" });
    const charOnRetired = await svc.createCharacter(p, { digitalHumanId: dh.value.id, name: "Y" });
    expect(charOnRetired.ok).toBe(false);
    if (!charOnRetired.ok) expect(charOnRetired.error.reason).toBe("inactive_parent");
  });

  it("enforces duplicate-handle rejection within org", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const ch = await svc.createCharacter(p, { name: "C" });
    if (!ch.ok) return expect.unreachable();
    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable();
    const first = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "dupe", displayName: "First" });
    expect(first.ok).toBe(true);
    const second = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "dupe", displayName: "Second" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.reason).toBe("invalid_handle");
  });

  it("enforces handle shape", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const ch = await svc.createCharacter(admin(ORG_A), { name: "C" });
    if (!ch.ok) return expect.unreachable();
    const pe = await svc.createPersona(admin(ORG_A), { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable();
    const bad = await svc.createAiCreator(admin(ORG_A), { personaId: pe.value.id, handle: "Bad Handle!", displayName: "B" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.reason).toBe("invalid_handle");
  });

  it("gates authoring behind people.manage (viewer cannot create)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const denied = await svc.createDigitalHuman(readOnly(ORG_A), { name: "No" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.reason).toBe("unauthorized");
    const noCapsResult = await svc.createDigitalHuman(noCaps(ORG_A), { name: "No" });
    expect(noCapsResult.ok).toBe(false);
  });

  it("gates reads behind people.read", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const denied = await svc.listAiCreators(noCaps(ORG_A));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.reason).toBe("unauthorized");
  });
});

describe("chain lifecycle (frozen invariant 5)", () => {
  const seedChain = async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const dh = await svc.createDigitalHuman(p, { name: "Ava" });
    if (!dh.ok) return expect.unreachable() as never;
    return { store, svc, p, dhId: dh.value.id };
  };

  it("allows draft → active and active → retired", async () => {
    const { svc, p, dhId } = await seedChain();
    const active = await svc.changeStatus(p, "digital_human", { id: dhId, status: "active" });
    expect(active.ok).toBe(true);
    const retired = await svc.changeStatus(p, "digital_human", { id: dhId, status: "retired" });
    expect(retired.ok).toBe(true);
  });

  it("rejects invalid transitions: retired is terminal, no active → draft", async () => {
    const { svc, p, dhId } = await seedChain();
    await svc.changeStatus(p, "digital_human", { id: dhId, status: "active" });
    await svc.changeStatus(p, "digital_human", { id: dhId, status: "retired" });
    const resurrect = await svc.changeStatus(p, "digital_human", { id: dhId, status: "active" });
    expect(resurrect.ok).toBe(false);
    if (!resurrect.ok) expect(resurrect.error.reason).toBe("invalid_status_transition");

    const backToDraft = await svc.changeStatus(p, "digital_human", { id: dhId, status: "draft" });
    expect(backToDraft.ok).toBe(false);
  });

  it("rejects cross-org status mutation with not_found (no existence leak)", async () => {
    const { svc, dhId } = await seedChain();
    const wrong = await svc.changeStatus(admin(ORG_B), "digital_human", { id: dhId, status: "active" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.reason).toBe("not_found");
  });

  it("rejects paused for chain aggregates (vocabulary exists only on ai_creator)", async () => {
    const { svc, p, dhId } = await seedChain();
    const paused = await svc.changeStatus(p, "digital_human", { id: dhId, status: "paused" });
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.reason).toBe("invalid_status_transition");
  });
});

describe("ai_creator paused lifecycle (authorized freeze fix 1)", () => {
  const seedCreator = async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    const p = admin(ORG_A);
    const ch = await svc.createCharacter(p, { name: "C" });
    if (!ch.ok) return expect.unreachable() as never;
    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable() as never;
    const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "ava", displayName: "Ava AI" });
    if (!ac.ok) return expect.unreachable() as never;
    return { svc, p, acId: ac.value.id };
  };

  it("1. draft → active succeeds", async () => {
    const { svc, p, acId } = await seedCreator();
    const res = await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    expect(res.ok).toBe(true);
  });

  it("2. active → paused succeeds · 3. paused → active succeeds", async () => {
    const { svc, p, acId } = await seedCreator();
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    const paused = await svc.changeStatus(p, "ai_creator", { id: acId, status: "paused" });
    expect(paused.ok).toBe(true);
    const revived = await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    expect(revived.ok).toBe(true);
  });

  it("4. active → retired succeeds", async () => {
    const { svc, p, acId } = await seedCreator();
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    const res = await svc.changeStatus(p, "ai_creator", { id: acId, status: "retired" });
    expect(res.ok).toBe(true);
  });

  it("5. paused → retired succeeds", async () => {
    const { svc, p, acId } = await seedCreator();
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "paused" });
    const res = await svc.changeStatus(p, "ai_creator", { id: acId, status: "retired" });
    expect(res.ok).toBe(true);
  });

  it("6. draft → paused fails · 7. paused → draft fails", async () => {
    const { svc, p, acId } = await seedCreator();
    const draftPaused = await svc.changeStatus(p, "ai_creator", { id: acId, status: "paused" });
    expect(draftPaused.ok).toBe(false);
    if (!draftPaused.ok) expect(draftPaused.error.reason).toBe("invalid_status_transition");

    await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "paused" });
    const pausedDraft = await svc.changeStatus(p, "ai_creator", { id: acId, status: "draft" });
    expect(pausedDraft.ok).toBe(false);
    if (!pausedDraft.ok) expect(pausedDraft.error.reason).toBe("invalid_status_transition");
  });

  it("8. retired → active fails · 9. retired → paused fails (retired terminal)", async () => {
    const { svc, p, acId } = await seedCreator();
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    await svc.changeStatus(p, "ai_creator", { id: acId, status: "retired" });
    const resurrect = await svc.changeStatus(p, "ai_creator", { id: acId, status: "active" });
    expect(resurrect.ok).toBe(false);
    if (!resurrect.ok) expect(resurrect.error.reason).toBe("invalid_status_transition");
    const unpause = await svc.changeStatus(p, "ai_creator", { id: acId, status: "paused" });
    expect(unpause.ok).toBe(false);
    if (!unpause.ok) expect(unpause.error.reason).toBe("invalid_status_transition");
  });

  it("10. cross-org status mutation still returns not_found", async () => {
    const { svc, acId } = await seedCreator();
    const wrong = await svc.changeStatus(admin(ORG_B), "ai_creator", { id: acId, status: "active" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.reason).toBe("not_found");
  });

  it("11. unauthorized roles remain forbidden", async () => {
    const { svc, acId } = await seedCreator();
    const blocked = await svc.changeStatus(readOnly(ORG_A), "ai_creator", { id: acId, status: "active" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.reason).toBe("unauthorized");
  });

  it("status changes keep using people.ai_creator_status_changed (no new audit action)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const p = admin(ORG_A);
    const ch = await svc.createCharacter(p, { name: "C" });
    if (!ch.ok) return expect.unreachable();
    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable();
    const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "ava", displayName: "Ava AI" });
    if (!ac.ok) return expect.unreachable();
    await svc.changeStatus(p, "ai_creator", { id: ac.value.id, status: "active" });
    await svc.changeStatus(p, "ai_creator", { id: ac.value.id, status: "paused" });
    const statusAudits = store.audit.filter((e) => e.action === "people.ai_creator_status_changed");
    expect(statusAudits).toHaveLength(2);
    expect(statusAudits[1]!.metadata).toEqual({ from: "active", to: "paused" });
    const actions = new Set(store.audit.map((e) => e.action));
    expect(actions.has("publish_started")).toBe(false);
    expect([...actions].every((a) => a.startsWith("people."))).toBe(true);
  });
});

describe("rights seam (D2.16-2)", () => {
  it("unwired port = vacuous pass (production composition)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) }); // NO rights injected
    const result = await svc.createDigitalHuman(admin(ORG_A), { name: "Ava" });
    expect(result.ok).toBe(true);
  });

  it("wired fake port: declared+unmet FAILS CLOSED; declared+met passes; undeclared passes", async () => {
    const make = (verdict: { declared: boolean; met: boolean }) =>
      createPeopleService({
        repository: fakeRepo(makeStore()),
        rights: { resolveRights: async () => verdict },
      });

    const blocked = await make({ declared: true, met: false }).createDigitalHuman(admin(ORG_A), { name: "Ava" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.reason).toBe("unauthorized");

    const allowed = await make({ declared: true, met: true }).createDigitalHuman(admin(ORG_A), { name: "Ava" });
    expect(allowed.ok).toBe(true);

    const vacuous = await make({ declared: false, met: false }).createDigitalHuman(admin(ORG_A), { name: "Ava" });
    expect(vacuous.ok).toBe(true);
  });
});

describe("publication-authored snapshot family (D2.16-3)", () => {
  type Repo = ReturnType<typeof fakeRepo> & { seedPublication: (publicationOrgId: string, versionOrgId: string, publicationId: string, publicationVersionId: string) => void };
  const snapshotInput = async (svc: ReturnType<typeof createPeopleService>, repo: Repo, versionId: string, orgId = ORG_A): Promise<ProfileSnapshotInput> => {
    const p = admin(orgId);
    const ch = await svc.createCharacter(p, { name: "C" });
    if (!ch.ok) return expect.unreachable() as never;
    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable() as never;
    const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "ava", displayName: "Ava AI" });
    if (!ac.ok) return expect.unreachable() as never;
    // Mediation invariant (freeze fix 2): the creator must be ACTIVE.
    const act = await svc.changeStatus(p, "ai_creator", { id: ac.value.id, status: "active" });
    if (!act.ok) return expect.unreachable() as never;
    const input = {
      orgId,
      aiCreatorId: ac.value.id,
      publicationId: seq(),
      publicationVersionId: versionId,
      handle: "ava",
      displayName: "Ava AI v1",
      bio: "hello",
      personalitySnapshot: { tone: "warm" },
      interestsSnapshot: ["art"],
      avatarRef: null,
      posterRef: null,
      messagingEnabled: false,
    };
    repo.seedPublication(orgId, orgId, input.publicationId, input.publicationVersionId);
    return input;
  };

  it("creates an active snapshot; replay of the SAME version is idempotent", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq());

    const first = await svc.upsertProfileSnapshot(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe("created");

    const replay = await svc.upsertProfileSnapshot(input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.kind).toBe("replayed");
    expect(store.pr).toHaveLength(1);
  });

  it("republish: previous snapshot → unpublished, new → active, history retained", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const v1 = await snapshotInput(svc, repo, seq());
    await svc.upsertProfileSnapshot(v1);

    const v2 = { ...v1, publicationId: seq(), publicationVersionId: seq(), displayName: "Ava AI v2", bio: "updated" };
    repo.seedPublication(ORG_A, ORG_A, v2.publicationId, v2.publicationVersionId);
    const second = await svc.upsertProfileSnapshot(v2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe("created");

    expect(store.pr).toHaveLength(2);
    const statuses = store.pr.map((r) => r.status).sort();
    expect(statuses).toEqual(["active", "unpublished"]);
    const activeRow = store.pr.find((r) => r.status === "active")!;
    expect(activeRow.publicationVersionId).toBe(v2.publicationVersionId);
    expect(activeRow.displayName).toBe("Ava AI v2");
    // Historical row unchanged (immutable snapshot content).
    const oldRow = store.pr.find((r) => r.publicationVersionId === v1.publicationVersionId)!;
    expect(oldRow.displayName).toBe("Ava AI v1");
  });

  it("unpublish: current → unpublished; repeated call idempotent; absent profile no-op", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq());
    await svc.upsertProfileSnapshot(input);

    const first = await svc.unpublishCurrentSnapshot({ orgId: ORG_A, aiCreatorId: input.aiCreatorId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe("retired");
    expect(store.pr.find((r) => r.status === "unpublished")).toBeTruthy();

    const again = await svc.unpublishCurrentSnapshot({ orgId: ORG_A, aiCreatorId: input.aiCreatorId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.kind).toBe("retired"); // idempotent re-retire
    expect(store.pr).toHaveLength(1);

    const absent = await svc.unpublishCurrentSnapshot({ orgId: ORG_A, aiCreatorId: seq() });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value.kind).toBe("absent");
  });

  it("rejects cross-org snapshot subject (anti-spoofing)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq(), ORG_A);
    const spoofed = await svc.upsertProfileSnapshot({ ...input, orgId: ORG_B });
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.error.reason).toBe("cross_org_reference");
  });

  // ---- Mediation re-check probes (authorized freeze fix 2) ----------------
  it("freeze fix 2: retired creator → mediation rejected (inactive_parent)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq());
    const p = admin(ORG_A);
    const retire = await svc.changeStatus(p, "ai_creator", { id: input.aiCreatorId, status: "retired" });
    expect(retire.ok).toBe(true);
    const snap = await svc.upsertProfileSnapshot(input);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.reason).toBe("inactive_parent");
    expect(store.pr).toHaveLength(0);
  });

  it("freeze fix 2: paused creator → mediation rejected (inactive_parent)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq());
    const p = admin(ORG_A);
    const pause = await svc.changeStatus(p, "ai_creator", { id: input.aiCreatorId, status: "paused" });
    expect(pause.ok).toBe(true);
    const snap = await svc.upsertProfileSnapshot(input);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.reason).toBe("inactive_parent");
  });

  it("freeze fix 2: missing publication version → mediation rejected (not_found)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq());
    const ghost = { ...input, publicationId: seq(), publicationVersionId: seq() };
    const snap = await svc.upsertProfileSnapshot(ghost);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.reason).toBe("not_found");
  });

  it("freeze fix 2: publication/version org mismatch → rejected (cross_org_reference)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const input = await snapshotInput(svc, repo, seq(), ORG_A);
    // Publication lives in org B; creator + mediation org are org A.
    repo.seedPublication(ORG_B, ORG_B, input.publicationId, input.publicationVersionId);
    const snap = await svc.upsertProfileSnapshot(input);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.reason).toBe("cross_org_reference");
    expect(store.pr).toHaveLength(0);
  });
});

describe("same-transaction audit (D2.4-1, frozen ten actions)", () => {
  it("emits the exact frozen action per mutation, actor = operator (authoring) / system (snapshot)", async () => {
    const store = makeStore();
    const repo = fakeRepo(store);
    const svc = createPeopleService({ repository: repo });
    const p = admin(ORG_A);

    const dh = await svc.createDigitalHuman(p, { name: "Ava" });
    if (!dh.ok) return expect.unreachable();
    const ch = await svc.createCharacter(p, { digitalHumanId: dh.value.id, name: "C" });
    if (!ch.ok) return expect.unreachable();
    const pe = await svc.createPersona(p, { characterId: ch.value.id, name: "P" });
    if (!pe.ok) return expect.unreachable();
    const ac = await svc.createAiCreator(p, { personaId: pe.value.id, handle: "ava", displayName: "Ava AI" });
    if (!ac.ok) return expect.unreachable();
    await svc.changeStatus(p, "digital_human", { id: dh.value.id, status: "active" });
    // Mediation invariant (freeze fix 2): the creator must be ACTIVE.
    await svc.changeStatus(p, "ai_creator", { id: ac.value.id, status: "active" });

    const snap = {
      orgId: ORG_A,
      aiCreatorId: ac.value.id,
      publicationId: seq(),
      publicationVersionId: seq(),
      handle: "ava",
      displayName: "Ava AI",
      bio: null,
      personalitySnapshot: {},
      interestsSnapshot: [],
      avatarRef: null,
      posterRef: null,
      messagingEnabled: false,
    };
    repo.seedPublication(ORG_A, ORG_A, snap.publicationId, snap.publicationVersionId);
    await svc.upsertProfileSnapshot(snap);
    await svc.unpublishCurrentSnapshot({ orgId: ORG_A, aiCreatorId: ac.value.id });

    const actions = store.audit.map((a) => a.action);
    expect(actions).toEqual([
      "people.digital_human_created",
      "people.character_created",
      "people.persona_created",
      "people.ai_creator_created",
      "people.digital_human_status_changed",
      "people.ai_creator_status_changed",
      "people.profile_snapshot_authored",
      "people.profile_snapshot_unpublished",
    ]);
    // Operator-originated rows carry the real operator id; snapshot rows use
    // the deterministic system actor (never a fabricated operator).
    expect(store.audit.find((a) => a.action === "people.digital_human_created")!.actorId).toBe(p.operatorId);
    expect(store.audit.find((a) => a.action === "people.profile_snapshot_authored")!.actorId).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
    // Snapshot audit rows carry publication provenance.
    const authored = store.audit.find((a) => a.action === "people.profile_snapshot_authored")!;
    expect(authored.targetType).toBe("creator_profile");
  });

  it("no audit rows for failed commands (rejected before mutation)", async () => {
    const store = makeStore();
    const svc = createPeopleService({ repository: fakeRepo(store) });
    await svc.createDigitalHuman(readOnly(ORG_A), { name: "Denied" });
    expect(store.audit).toHaveLength(0);
  });
});

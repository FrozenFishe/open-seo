import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rankTrackingConfigs } from "@/db/schema";
import { RankTrackingRepository } from "./RankTrackingRepository";

// Config scheduling and keyword queries against real SQL.

const testDb = await vi.hoisted(async () => {
  const { createRankTrackingTestDb } = await import("./rankTrackingTestDb");
  return createRankTrackingTestDb();
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  DB_BATCH_SIZE: 100,
  executeInBatches: testDb.executeInBatches,
}));

const { client, seedProject, seedConfig, seedKeywords } = testDb;

beforeEach(async () => {
  await testDb.clear();
});

const NOW = "2026-08-01T12:00:00.000Z";

async function getConfigRow(id: string) {
  const rows = await testDb.db
    .select({
      nextCheckAt: rankTrackingConfigs.nextCheckAt,
      lastSkipReason: rankTrackingConfigs.lastSkipReason,
    })
    .from(rankTrackingConfigs)
    .where(eq(rankTrackingConfigs.id, id));
  return rows[0];
}

describe("getDueConfigsWithOrganization", () => {
  it("returns due rows oldest-first and excludes manual, inactive, future, and archived rows", async () => {
    await seedProject("proj_1");
    await seedProject("proj_archived", "2026-07-15T00:00:00.000Z");
    await seedConfig({
      id: "cfg_newer",
      nextCheckAt: "2026-07-02T05:00:00.000Z",
    });
    await seedConfig({
      id: "cfg_oldest",
      nextCheckAt: "2026-07-01T05:00:00.000Z",
    });
    // Same timestamp as cfg_oldest — id breaks the tie deterministically.
    await seedConfig({
      id: "cfg_tie",
      nextCheckAt: "2026-07-01T05:00:00.000Z",
    });
    await seedConfig({ id: "cfg_manual", scheduleInterval: "manual" });
    await seedConfig({ id: "cfg_inactive", isActive: 0 });
    await seedConfig({
      id: "cfg_future",
      nextCheckAt: "2027-01-01T05:00:00.000Z",
    });
    await seedConfig({ id: "cfg_null_due", nextCheckAt: null });
    await seedConfig({ id: "cfg_archived", projectId: "proj_archived" });

    const due = await RankTrackingRepository.getDueConfigsWithOrganization(NOW);

    expect(due.map((c) => c.id)).toEqual([
      "cfg_oldest",
      "cfg_tie",
      "cfg_newer",
    ]);
    expect(due[0].organizationId).toBe("org_proj_1");
  });
});

describe("claimDueConfig", () => {
  it("advances the schedule and writes the skip reason when the token matches", async () => {
    await seedProject("proj_1");
    await seedConfig({ id: "cfg_1", nextCheckAt: "2026-07-01T05:00:00.000Z" });

    const claimed = await RankTrackingRepository.claimDueConfig({
      configId: "cfg_1",
      projectId: "proj_1",
      observedNextCheckAt: "2026-07-01T05:00:00.000Z",
      nextCheckAt: "2026-08-02T05:00:00.000Z",
      lastSkipReason: "plan_required",
    });

    expect(claimed).toBe(true);
    expect(await getConfigRow("cfg_1")).toEqual({
      nextCheckAt: "2026-08-02T05:00:00.000Z",
      lastSkipReason: "plan_required",
    });
  });

  it("refuses when the observed token no longer matches, leaving the row untouched", async () => {
    await seedProject("proj_1");
    await seedConfig({
      id: "cfg_1",
      nextCheckAt: "2026-07-20T05:00:00.000Z",
      lastSkipReason: "insufficient_credits",
    });

    const claimed = await RankTrackingRepository.claimDueConfig({
      configId: "cfg_1",
      projectId: "proj_1",
      observedNextCheckAt: "2026-07-01T05:00:00.000Z",
      nextCheckAt: "2026-08-02T05:00:00.000Z",
      lastSkipReason: null,
    });

    expect(claimed).toBe(false);
    expect(await getConfigRow("cfg_1")).toEqual({
      nextCheckAt: "2026-07-20T05:00:00.000Z",
      lastSkipReason: "insufficient_credits",
    });
  });

  it("refuses deactivated rows and preserves the skip reason when omitted", async () => {
    await seedProject("proj_1");
    await seedConfig({ id: "cfg_off", isActive: 0 });
    await seedConfig({
      id: "cfg_restore",
      nextCheckAt: "2026-08-02T05:00:00.000Z",
      lastSkipReason: "insufficient_credits",
    });

    expect(
      await RankTrackingRepository.claimDueConfig({
        configId: "cfg_off",
        projectId: "proj_1",
        observedNextCheckAt: "2026-07-01T05:00:00.000Z",
        nextCheckAt: "2026-08-02T05:00:00.000Z",
      }),
    ).toBe(false);

    // Restore-shaped claim: no lastSkipReason key — the existing value stays.
    expect(
      await RankTrackingRepository.claimDueConfig({
        configId: "cfg_restore",
        projectId: "proj_1",
        observedNextCheckAt: "2026-08-02T05:00:00.000Z",
        nextCheckAt: "2026-07-01T05:00:00.000Z",
      }),
    ).toBe(true);
    expect(await getConfigRow("cfg_restore")).toEqual({
      nextCheckAt: "2026-07-01T05:00:00.000Z",
      lastSkipReason: "insufficient_credits",
    });
  });
});

describe("getKeywordCountsForConfigs", () => {
  it("groups counts by config and omits configs with no keywords", async () => {
    await seedProject("proj_1");
    await seedConfig({ id: "cfg_a" });
    await seedConfig({ id: "cfg_b" });
    await seedKeywords([
      ["kw1", "cfg_a"],
      ["kw2", "cfg_a"],
      ["kw3", "cfg_b"],
    ]);

    const counts = await RankTrackingRepository.getKeywordCountsForConfigs([
      "cfg_a",
      "cfg_b",
      "cfg_missing",
    ]);

    expect(counts).toEqual(
      new Map([
        ["cfg_a", 2],
        ["cfg_b", 1],
      ]),
    );
    expect(await RankTrackingRepository.getKeywordCountsForConfigs([])).toEqual(
      new Map(),
    );
  });
});

describe("setKeywordsPinned", () => {
  it("pins and unpins only keywords of the given config", async () => {
    await seedProject("proj_1");
    await seedConfig({ id: "cfg_a" });
    await seedConfig({ id: "cfg_b" });
    await seedKeywords([
      ["kw1", "cfg_a"],
      ["kw2", "cfg_b"],
    ]);
    const pinnedIds = async () =>
      (
        await client.execute(
          "SELECT id FROM rank_tracking_keywords WHERE pinned_at IS NOT NULL",
        )
      ).rows.map((row) => row.id);

    // kw2 belongs to another config, so the config predicate skips it.
    expect(
      await RankTrackingRepository.setKeywordsPinned(
        ["kw1", "kw2"],
        "cfg_a",
        true,
      ),
    ).toEqual(["kw1"]);
    expect(await pinnedIds()).toEqual(["kw1"]);

    await RankTrackingRepository.setKeywordsPinned(["kw1"], "cfg_a", false);
    expect(await pinnedIds()).toEqual([]);
  });
});

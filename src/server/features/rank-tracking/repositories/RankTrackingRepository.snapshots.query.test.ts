import { beforeEach, describe, expect, it, vi } from "vitest";
import { RankTrackingRepository } from "./RankTrackingRepository";

// Run trend and snapshot retry queries against real SQL.

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

const { client } = testDb;

beforeEach(async () => {
  await testDb.clear();
});

const NOW = "2026-08-01T12:00:00.000Z";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

describe("getConfigTrend", () => {
  it("keeps every row of a run inside the range and drops a run that started before it", async () => {
    // run_b started before the 30-day cutoff, but one snapshot is after it.
    for (const [runId, startedAt, snapshotTimes] of [
      ["run_a", daysAgo(10), [daysAgo(10), daysAgo(10)]],
      ["run_b", daysAgo(30.01), [daysAgo(30.01), daysAgo(29.99)]],
    ] as const) {
      await client.execute({
        sql: "INSERT INTO rank_check_runs (id, config_id, project_id, status, keywords_total, started_at) VALUES (?, 'cfg_a', 'proj_1', 'completed', 2, ?)",
        args: [runId, startedAt],
      });
      for (const [index, checkedAt] of snapshotTimes.entries()) {
        await client.execute({
          sql: "INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position, checked_at) VALUES (?, ?, 'kw', 'desktop', 5, ?)",
          args: [runId, `kw${index}`, checkedAt],
        });
      }
    }

    const trend = await RankTrackingRepository.getConfigTrend(
      "cfg_a",
      "desktop",
      30,
    );

    expect(trend).toMatchObject([
      { runId: "run_a", keywordsTotal: 2, total: 2 },
    ]);
  });
});

async function seedRun(id: string, status: string) {
  await client.execute({
    sql: "INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at) VALUES (?, 'cfg_a', 'proj_1', ?, ?)",
    args: [id, status, NOW],
  });
}

function snapshotRow(
  runId: string,
  trackingKeywordId: string,
  device: "desktop" | "mobile",
  position: number | null,
) {
  return { runId, trackingKeywordId, keyword: "kw", device, position };
}

describe("retry snapshot queries", () => {
  it("finds each keyword's best position on any device from completed runs only", async () => {
    await seedRun("run_done", "completed");
    await seedRun("run_active", "running");
    await RankTrackingRepository.insertSnapshots([
      snapshotRow("run_done", "kw_ranked", "desktop", null),
      snapshotRow("run_done", "kw_ranked", "mobile", 4),
      snapshotRow("run_done", "kw_never", "desktop", null),
      snapshotRow("run_active", "kw_never", "mobile", 1),
    ]);

    const best =
      await RankTrackingRepository.getBestPositionsForKeywords("cfg_a");

    expect(best).toEqual(
      expect.arrayContaining([
        { trackingKeywordId: "kw_never", position: null },
        { trackingKeywordId: "kw_ranked", position: 4 },
      ]),
    );
  });

  it("upserts a retry's result over the saved one, and keeps it through miss cleanup", async () => {
    await seedRun("run_a", "running");
    await RankTrackingRepository.insertSnapshots([
      snapshotRow("run_a", "kw_0", "desktop", null),
    ]);

    await RankTrackingRepository.upsertSnapshots([
      snapshotRow("run_a", "kw_0", "desktop", 2),
      snapshotRow("run_a", "kw_1", "desktop", 7),
    ]);

    // Cleanup of unconfirmed misses never removes a row that holds a position.
    await RankTrackingRepository.deleteNotFoundSnapshots([
      { runId: "run_a", trackingKeywordId: "kw_0", device: "desktop" },
    ]);

    const rows = await RankTrackingRepository.getSnapshotsForRun("run_a");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trackingKeywordId: "kw_0", position: 2 }),
        expect.objectContaining({ trackingKeywordId: "kw_1", position: 7 }),
      ]),
    );
  });
});

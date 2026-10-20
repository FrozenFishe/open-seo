import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

/**
 * Real in-memory SQLite for the rank tracking repository query tests, so the
 * scoping predicates, due-query ordering, compare-and-set claims and snapshot
 * upserts run against actual SQL — the parts the mocked service tests can't
 * see. Create it inside `vi.hoisted` and serve it from mocked `@/db` and
 * `@/db/runBatch`.
 */
export async function createRankTrackingTestDb() {
  const client = createClient({ url: "file::memory:" });
  const db = drizzle(client);
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT
    );
    CREATE TABLE rank_tracking_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      devices TEXT NOT NULL DEFAULT 'both',
      serp_depth INTEGER NOT NULL,
      schedule_interval TEXT NOT NULL DEFAULT 'weekly',
      location_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      next_check_at TEXT,
      last_skip_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_tracking_keywords (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      search_volume INTEGER,
      keyword_difficulty INTEGER,
      cpc REAL,
      pinned_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      keywords_total INTEGER NOT NULL DEFAULT 0,
      is_subset_run INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL
    );
    CREATE TABLE rank_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tracking_keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      device TEXT NOT NULL,
      position INTEGER,
      url TEXT,
      serp_features TEXT,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX rank_snapshots_run_keyword_device_idx
      ON rank_snapshots (run_id, tracking_keyword_id, device);
  `);

  /** Runs batched writes one by one against the same in-memory database. */
  const executeInBatches = async <T>(
    items: T[],
    build: (tx: typeof db, item: T) => Promise<unknown>,
  ) => {
    for (const item of items) await build(db, item);
  };

  const clear = () =>
    client.executeMultiple(`
      DELETE FROM rank_snapshots;
      DELETE FROM rank_check_runs;
      DELETE FROM rank_tracking_keywords;
      DELETE FROM rank_tracking_configs;
      DELETE FROM projects;
    `);

  /** Adds project `id`, owned by organization `org_<id>`. */
  const seedProject = async (id: string, archivedAt: string | null = null) => {
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name, archived_at) VALUES (?, ?, ?, ?)",
      args: [id, `org_${id}`, id, archivedAt],
    });
  };

  const seedConfig = async (input: {
    id: string;
    projectId?: string;
    nextCheckAt?: string | null;
    scheduleInterval?: string;
    isActive?: number;
    lastSkipReason?: string | null;
  }) => {
    await client.execute({
      sql: `INSERT INTO rank_tracking_configs
        (id, project_id, domain, serp_depth, schedule_interval, is_active, next_check_at, last_skip_reason)
        VALUES (?, ?, ?, 20, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.projectId ?? "proj_1",
        `${input.id}.example.com`,
        input.scheduleInterval ?? "daily",
        input.isActive ?? 1,
        input.nextCheckAt === undefined
          ? "2026-07-01T05:00:00.000Z"
          : input.nextCheckAt,
        input.lastSkipReason ?? null,
      ],
    });
  };

  const seedKeywords = async (keywords: ReadonlyArray<[string, string]>) => {
    for (const [id, configId] of keywords) {
      await client.execute({
        sql: "INSERT INTO rank_tracking_keywords (id, config_id, keyword) VALUES (?, ?, ?)",
        args: [id, configId, id],
      });
    }
  };

  return {
    client,
    db,
    executeInBatches,
    clear,
    seedProject,
    seedConfig,
    seedKeywords,
  };
}

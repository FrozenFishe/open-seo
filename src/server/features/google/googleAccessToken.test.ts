import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoogleAccessToken } from "./googleOAuth";

// Grants live in a real SQLite `account` table: the lookup must select the
// caller's grant for one provider and Google account, and a mocked builder
// chain would ignore the WHERE clause.
const sqlite = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  await client.execute(
    "CREATE TABLE account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL, access_token text, refresh_token text, access_token_expires_at integer, updated_at integer NOT NULL)",
  );
  return { client, db: drizzle(client) };
});

const mocks = vi.hoisted(() => ({
  getGoogleOAuthClientConfig: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  getAuth: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: sqlite.db }));
vi.mock("@/lib/auth", () => ({ getAuth: mocks.getAuth }));
vi.mock("./oauth-config", () => ({
  getGoogleOAuthClientConfig: mocks.getGoogleOAuthClientConfig,
}));

const hour = 60 * 60 * 1_000;
const request = {
  userId: "user-1",
  providerId: "google-search-console",
  accountId: "google-account-1",
};

/** The requested grant plus decoys that differ by one owner field each.
 *  Decoys are inserted first so a dropped filter would select one. */
async function seedGrants(target: {
  refreshToken: string | null;
  expiresAt: number | null;
}) {
  const decoy = Date.now() + hour;
  await sqlite.client.execute({
    sql: `INSERT INTO account VALUES
      ('other-user', 'google-account-1', 'google-search-console', 'user-2', 'other-user-token', 'r', ?, 0),
      ('other-provider', 'google-account-1', 'google-analytics', 'user-1', 'other-provider-token', 'r', ?, 0),
      ('other-account', 'google-account-0', 'google-search-console', 'user-1', 'other-account-token', 'r', ?, 0),
      ('target', 'google-account-1', 'google-search-console', 'user-1', 'stored-access', ?, ?, 0)`,
    args: [decoy, decoy, decoy, target.refreshToken, target.expiresAt],
  });
}

async function accessTokens() {
  const result = await sqlite.client.execute(
    "SELECT id, access_token FROM account ORDER BY id",
  );
  return result.rows.map((row) => [row.id, row.access_token]);
}

describe("getGoogleAccessToken", () => {
  beforeEach(async () => {
    await sqlite.client.execute("DELETE FROM account");
    mocks.getGoogleOAuthClientConfig.mockResolvedValue({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
    mocks.getAuth.mockReturnValue({
      $context: Promise.resolve({
        options: { account: { encryptOAuthTokens: false } },
        secretConfig: "secret",
      }),
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("returns only the caller's fresh token for the requested provider and account", async () => {
    await seedGrants({ refreshToken: "r", expiresAt: Date.now() + hour });

    await expect(getGoogleAccessToken(request)).resolves.toBe("stored-access");
    await expect(
      getGoogleAccessToken({ ...request, userId: "user-3" }),
    ).rejects.toThrow("No google-search-console grant for this user.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists it on that grant only", async () => {
    await seedGrants({
      refreshToken: "stored-refresh",
      expiresAt: Date.now() + 1_000,
    });
    const before = await accessTokens();
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3600 }),
        { status: 200 },
      ),
    );

    await expect(getGoogleAccessToken(request)).resolves.toBe("new-access");
    const body = mocks.fetch.mock.calls[0][1]?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("form body");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
    expect(await accessTokens()).toEqual(
      before.map(([id, token]) => [id, id === "target" ? "new-access" : token]),
    );
  });

  it("rejects an expired grant that has no refresh token", async () => {
    await seedGrants({ refreshToken: null, expiresAt: Date.now() - 1_000 });

    await expect(getGoogleAccessToken(request)).rejects.toThrow(
      /cannot be refreshed/,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects when Google refuses the refresh and keeps the stored token", async () => {
    await seedGrants({ refreshToken: "stored-refresh", expiresAt: null });
    const before = await accessTokens();
    mocks.fetch.mockResolvedValue(new Response("", { status: 400 }));

    await expect(getGoogleAccessToken(request)).rejects.toThrow(
      /refused to refresh/,
    );
    expect(await accessTokens()).toEqual(before);
  });
});

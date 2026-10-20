import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4AdminApiError, Ga4TokenError } from "@/server/lib/ga4Errors";
import { Ga4Service } from "./Ga4Service";

// Grants are read from a real SQLite `account` table so the user and provider
// filters are exercised; a mocked builder chain would ignore the WHERE clause.
const grants = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  await client.execute(
    "CREATE TABLE account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL)",
  );
  return {
    db: drizzle(client),
    async seed(
      rows: Array<{ accountId: string; userId?: string; providerId?: string }>,
    ) {
      await client.execute("DELETE FROM account");
      for (const [index, row] of rows.entries()) {
        await client.execute({
          sql: "INSERT INTO account VALUES (?, ?, ?, ?)",
          args: [
            `grant-${index}`,
            row.accountId,
            row.providerId ?? "google-analytics",
            row.userId ?? "u1",
          ],
        });
      }
    },
  };
});

const mocks = vi.hoisted(() => {
  const listProperties = vi.fn();
  const getProperty = vi.fn();
  const getUserInfoEmail = vi.fn();
  return {
    listProperties,
    getProperty,
    getUserInfoEmail,
    createGa4AdminClient: vi.fn(() => ({
      listProperties,
      getProperty,
      getUserInfoEmail,
    })),
    upsert: vi.fn(),
    getByProjectId: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: grants.db }));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4AdminClient: mocks.createGa4AdminClient,
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    upsert: mocks.upsert,
    getByProjectId: mocks.getByProjectId,
  },
}));

describe("Ga4Service", () => {
  beforeEach(async () => {
    await grants.seed([{ accountId: "sub-a" }]);
  });

  it("verifies a freshly discovered property before persisting metadata", async () => {
    mocks.listProperties.mockResolvedValue([
      {
        propertyId: "properties/11",
        displayName: "Site A",
        accountDisplayName: "Agency",
      },
    ]);
    mocks.getProperty.mockResolvedValue({
      name: "properties/11",
      displayName: "Site A",
      timeZone: "America/New_York",
      currencyCode: "USD",
    });
    mocks.getUserInfoEmail.mockResolvedValue("client@example.com");
    mocks.upsert.mockResolvedValue({ propertyId: "properties/11" });
    const input = {
      projectId: "p1",
      organizationId: "org1",
      propertyId: "properties/11",
      accountId: "sub-a",
      userId: "u1",
    };

    await Ga4Service.setProperty(input);

    expect(mocks.upsert).toHaveBeenCalledWith({
      projectId: "p1",
      organizationId: "org1",
      propertyId: "properties/11",
      propertyDisplayName: "Site A",
      propertyTimeZone: "America/New_York",
      propertyCurrencyCode: "USD",
      connectedByUserId: "u1",
      ga4AccountId: "sub-a",
      connectedAccountEmail: "client@example.com",
    });

    // A userinfo failure is non-fatal: the email is passed through as null.
    mocks.getUserInfoEmail.mockRejectedValue(new Error("userinfo unavailable"));
    await Ga4Service.setProperty(input);
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectedAccountEmail: null }),
    );
  });

  it("rejects a property or connector the current user does not own", async () => {
    // The requested sub exists, but only as another user's GA4 grant and as
    // this user's Search Console grant; neither may authorize the connection.
    await grants.seed([
      { accountId: "sub-a" },
      { accountId: "foreign-sub", userId: "u2" },
      { accountId: "foreign-sub", providerId: "google-search-console" },
    ]);
    await expect(
      Ga4Service.setProperty({
        projectId: "p1",
        organizationId: "org1",
        propertyId: "properties/11",
        accountId: "foreign-sub",
        userId: "u1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.createGa4AdminClient).not.toHaveBeenCalled();

    mocks.listProperties.mockResolvedValue([]);
    await expect(
      Ga4Service.setProperty({
        projectId: "p1",
        organizationId: "org1",
        propertyId: "properties/11",
        accountId: "sub-a",
        userId: "u1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("distinguishes expired grants from inaccessible property discovery", async () => {
    await grants.seed([
      { accountId: "sub-a" },
      { accountId: "sub-b" },
      { accountId: "sub-c", userId: "u2" },
    ]);
    mocks.listProperties
      .mockRejectedValueOnce(new Ga4TokenError("revoked"))
      .mockRejectedValueOnce(new Ga4AdminApiError(403, "forbidden"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      Ga4Service.listPropertiesForUserWithGrantStatus("u1"),
    ).resolves.toEqual({
      accounts: [
        {
          accountId: "sub-a",
          email: null,
          requiresReconnect: true,
          propertiesUnavailable: false,
          properties: [],
        },
        {
          accountId: "sub-b",
          email: null,
          requiresReconnect: false,
          propertiesUnavailable: true,
          properties: [],
        },
      ],
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("ga4.property_discovery_failed", {
      errorName: "Ga4AdminApiError",
      status: 403,
    });
    consoleError.mockRestore();
  });
});

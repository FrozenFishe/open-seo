import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  creditsForProviderUsd,
} from "@/shared/billing";

// Runs the real section fetchers behind the metered client (client.test.ts
// mocks them), so a billed response that fails validation is checked all the
// way to the Autumn settle.

const { checkMock, finalizeMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  finalizeMock: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/server/billing/autumn", () => ({
  autumn: { check: checkMock, balances: { finalize: finalizeMock } },
  AUTUMN_TRACK_RETRY_OPTIONS: {},
}));

vi.mock("@/server/billing/subscription", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrCreateOrganizationCustomer: vi.fn(async () => ({ id: "org_123" })),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(async () => true),
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

vi.mock("@/server/email/onboarding-drip", () => ({
  sendCreditsExhaustedEvent: vi.fn(),
}));

import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { buildLlmTarget } from "@/server/lib/dataforseo/shared";

const COST_USD = 0.02;

const client = createDataforseoClient({
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "alice@example.com",
});

function billedResponse(path: string[], result: unknown[]) {
  return Response.json({
    status_code: 20000,
    tasks: [{ status_code: 20000, path, cost: COST_USD, result }],
  });
}

beforeEach(() => {
  checkMock.mockImplementation(async (args: { featureId: string }) => {
    const remaining =
      args.featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID ? 5000 : 0;
    return { allowed: true, balance: { remaining } };
  });
  finalizeMock.mockResolvedValue({ success: true });
});

describe("billed DataForSEO response with a malformed payload", () => {
  it.each([
    {
      name: "backlinks summary",
      path: ["v3", "backlinks", "summary", "live"],
      result: [{ rank: "high" }],
      call: () => client.backlinks.summary({ target: "example.com" }),
      message:
        "DataForSEO backlinks-summary-live returned an invalid response shape",
    },
    {
      name: "backlinks rows",
      path: ["v3", "backlinks", "backlinks", "live"],
      result: [{ items: [{ rank: "high" }] }],
      call: () => client.backlinks.rows({ target: "example.com" }),
      message: "DataForSEO backlinks-live returned an invalid response shape",
    },
    {
      name: "LLM mentions search",
      path: ["v3", "ai_optimization", "llm_mentions", "search", "live"],
      result: [{ items: [{ question: 42 }] }],
      call: () =>
        client.aiSearch.mentionsSearch({
          target: buildLlmTarget({ type: "domain", value: "example.com" }),
          platform: "google",
          locationCode: 2840,
          languageCode: "en",
        }),
      message:
        "DataForSEO llm_mentions/search returned an invalid mention items shape",
    },
  ])(
    "$name charges the billed cost instead of releasing the hold",
    async ({ path, result, call, message }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => billedResponse(path, result)),
      );

      await expect(call()).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message,
      });

      expect(finalizeMock).toHaveBeenCalledTimes(1);
      expect(finalizeMock.mock.calls[0][0]).toMatchObject({
        action: "confirm",
        overrideValue: creditsForProviderUsd(COST_USD),
      });
    },
  );
});

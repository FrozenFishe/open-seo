import { beforeEach, describe, expect, it, vi } from "vitest";
import { billResearchSpend, type ResearchSpend } from "./researchSpend";

const mocks = vi.hoisted(() => ({
  isHostedServerAuthMode: vi.fn(),
  getUsageCreditsRemaining: vi.fn(),
  trackUsageCreditSpend: vi.fn(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));
vi.mock("./subscription", () => ({
  getUsageCreditsRemaining: mocks.getUsageCreditsRemaining,
  trackUsageCreditSpend: mocks.trackUsageCreditSpend,
}));

const customer = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "owner@example.com",
  projectId: "project_1",
};
const spend: ResearchSpend[] = [
  {
    provider: "openrouter",
    creditFeature: "ai_prompt_responses",
    operation: "prompt_research",
    costUsd: 0.2,
  },
  {
    provider: "context",
    creditFeature: "ai_prompt_responses",
    operation: "scrape",
    costUsd: 0,
  },
  {
    provider: "dataforseo",
    creditFeature: "keyword_research",
    operation: "keyword_ideas",
    costUsd: 0.1,
  },
];

beforeEach(() => {
  mocks.isHostedServerAuthMode.mockResolvedValue(true);
  mocks.getUsageCreditsRemaining.mockResolvedValue({
    monthlyRemaining: 100,
    topupRemaining: 50,
  });
  mocks.trackUsageCreditSpend.mockResolvedValue({
    monthlyCredits: 30,
    topupCredits: 20,
  });
});

describe("billResearchSpend", () => {
  it("charges each paid item against the balance left by earlier charges", async () => {
    await billResearchSpend(customer, spend);

    expect(mocks.getUsageCreditsRemaining).toHaveBeenCalledOnce();
    expect(mocks.getUsageCreditsRemaining).toHaveBeenCalledWith("org_1");
    expect(mocks.trackUsageCreditSpend.mock.calls).toEqual([
      [
        {
          customer,
          customerId: "org_1",
          creditFeature: "ai_prompt_responses",
          costUsd: 0.2,
          monthlyRemaining: 100,
          overdraft: { topupRemaining: 50 },
          properties: { provider: "openrouter", operation: "prompt_research" },
        },
      ],
      [
        {
          customer,
          customerId: "org_1",
          creditFeature: "keyword_research",
          costUsd: 0.1,
          monthlyRemaining: 70,
          overdraft: { topupRemaining: 30 },
          properties: { provider: "dataforseo", operation: "keyword_ideas" },
        },
      ],
    ]);
  });

  it("does not meter self-hosted research", async () => {
    mocks.isHostedServerAuthMode.mockResolvedValue(false);

    await billResearchSpend(customer, spend);

    expect(mocks.getUsageCreditsRemaining).not.toHaveBeenCalled();
    expect(mocks.trackUsageCreditSpend).not.toHaveBeenCalled();
  });

  it("logs a metering failure without failing the research or replaying the charge", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.trackUsageCreditSpend.mockRejectedValueOnce(new Error("Autumn down"));

    await expect(billResearchSpend(customer, spend)).resolves.toBeUndefined();

    expect(mocks.trackUsageCreditSpend).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "Research credit metering failed",
      expect.objectContaining({ organizationId: "org_1" }),
    );
  });
});

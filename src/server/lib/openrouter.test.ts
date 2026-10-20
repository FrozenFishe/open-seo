import { generateText } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

const completion = () =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  });

// The egress country is cached per module (one lookup per isolate), so each
// test needs a fresh module to run its own lookup.
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function requestedModel(trace: () => Promise<Response>) {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(trace)
    .mockResolvedValueOnce(completion());
  const { buildChatAgentModel } = await import("./openrouter");
  await generateText({
    model: buildChatAgentModel({ apiKey: "key", authMode: undefined }),
    prompt: "hi",
  });
  const body = z
    .object({ model: z.string() })
    .parse(JSON.parse(z.string().parse(fetchMock.mock.calls[1]?.[1]?.body)));
  return body.model;
}

it("sends OpenAI calls to MiniMax M3 from a country where OpenAI is blocked", async () => {
  expect(
    await requestedModel(async () => new Response("colo=HKG\nloc=HK\n")),
  ).toBe("minimax/minimax-m3");
});

it("stays on OpenAI when the country lookup fails", async () => {
  expect(
    await requestedModel(async () => {
      throw new Error("offline");
    }),
  ).toBe("openai/gpt-5.6-luna");
});

it("runs AI features against OPENROUTER_BASE_URL without a key, metering $0", async () => {
  vi.stubEnv("AUTH_MODE", "local_noauth");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_BASE_URL", "http://vllm:8000/v1");
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(completion());
  const { buildAiFeatureModel } = await import("./openrouter");
  const ai = await buildAiFeatureModel("low");
  const result = await generateText({ model: ai.model, prompt: "hi" });

  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe("http://vllm:8000/v1/chat/completions");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local");
  const body: unknown = JSON.parse(z.string().parse(init?.body));
  expect(body).not.toHaveProperty("usage");
  expect(body).not.toHaveProperty("reasoning");
  expect(ai.costUsd(result.providerMetadata)).toBe(0);
});

it("ignores OPENROUTER_BASE_URL in hosted mode, so a missing key fails closed", async () => {
  vi.stubEnv("AUTH_MODE", "hosted");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_BASE_URL", "http://vllm:8000/v1");
  const { buildAiFeatureModel } = await import("./openrouter");
  await expect(buildAiFeatureModel("low")).rejects.toThrow(
    "OPENROUTER_API_KEY",
  );
});

it("rejects AI features when neither a key nor a base URL is set", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_BASE_URL", "");
  const { buildAiFeatureModel } = await import("./openrouter");
  await expect(buildAiFeatureModel("low")).rejects.toThrow(
    "OPENROUTER_API_KEY",
  );
});

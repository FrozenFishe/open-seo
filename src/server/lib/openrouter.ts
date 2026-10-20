import {
  createOpenRouter,
  type LanguageModelV3,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import {
  openRouterCostUsd,
  requireOpenRouterCostUsd,
} from "@/server/lib/chatAgent";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// OpenRouter model slug used for the SAM in-app chat agent. Override with
// OPENROUTER_MODEL to swap models without a code change.
const DEFAULT_CHAT_AGENT_MODEL = "openai/gpt-5.6-luna";

// Previous default; kept reachable via OPENROUTER_MODEL for rollback, and the
// fallback where OpenAI is blocked. Its routing needs the ZDR/provider tuning
// below.
const MINIMAX_M3 = "minimax/minimax-m3";

// OpenRouter rejects OpenAI models for requests from these countries ("This
// model is not available in your region"). Workflows and Durable Objects run
// near the user, outside prod's US placement.
const OPENAI_BLOCKED_COUNTRIES = [
  "CN",
  "HK",
  "MO",
  "RU",
  "BY",
  "IR",
  "KP",
  "SY",
  "CU",
];

// The country this isolate's requests leave from. An isolate stays in one
// location, so one lookup serves its lifetime. Caches the value, not the
// promise: Workers can't share a pending fetch across requests. Fails open: a
// slow or failed lookup leaves the country unknown, and calls stay on OpenAI.
let egressCountry: string | undefined;
async function openAiBlockedHere(): Promise<boolean> {
  egressCountry ??= await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.text())
    .then((trace) => /^loc=(\w+)$/m.exec(trace)?.[1] ?? "")
    .catch(() => "");
  return OPENAI_BLOCKED_COUNTRIES.includes(egressCountry);
}

// Fails closed: hosted billing needs OpenRouter's reported cost, so hosted
// mode never routes to a base URL.
function selfHostedBaseUrl(config: {
  baseURL?: string;
  authMode: string | undefined;
}) {
  return isHostedAuthMode(config.authMode) ? undefined : config.baseURL;
}

/**
 * Returns the AI SDK LanguageModel for the chat agent. `usage: { include: true }`
 * turns on OpenRouter usage accounting so each response carries its real USD
 * cost (providerMetadata.openrouter.usage.cost) — which we meter against the
 * shared usage-credit pool.
 *
 * Default model: GPT-5.6 Luna at `reasoning.effort: "max"` — "max" is valid at
 * the OpenRouter API for GPT-5.x but missing from the SDK's effort union, so
 * the reasoning config rides in `extraBody`. Reasoning tokens stream on the
 * separate reasoning channel and are billed as output tokens, which the usage
 * accounting above captures.
 *
 * `baseURL` points the provider at any OpenAI-compatible endpoint (self-hosted
 * vLLM, Ollama, ...) for self-hosted deployments. Those servers accept plain
 * chat completions and reject or ignore OpenRouter-specific fields, so the
 * request is sent without usage accounting, provider routing, or reasoning
 * tuning — local inference meters as $0. Hosted mode ignores `baseURL`: its
 * billing meters OpenRouter's reported cost, which a base URL would zero out,
 * so hosted always talks to OpenRouter and fails without a key.
 *
 * Sync on purpose: Think's `getModel()` hook is sync and runs on every turn,
 * so the SAM agent reads the key/model from its DO env and builds here.
 */
export function buildChatAgentModel(
  config: {
    apiKey: string | undefined;
    modelId?: string;
    baseURL?: string;
    authMode: string | undefined;
  },
  reasoningEffort: "max" | "low" = "max",
): LanguageModelV3 {
  const { apiKey } = config;
  const model = config.modelId ?? DEFAULT_CHAT_AGENT_MODEL;
  const baseURL = selfHostedBaseUrl(config);
  if (!apiKey && !baseURL) {
    throw new Error(
      "Missing required environment variable: OPENROUTER_API_KEY (or OPENROUTER_BASE_URL for a self-hosted endpoint)",
    );
  }
  // A self-hosted endpoint needs no real key; a placeholder stands in.
  const openrouter = createOpenRouter({
    apiKey: apiKey || "local",
    ...(baseURL ? { baseURL } : {}),
  });
  if (baseURL) return openrouter(model);

  const primary = openRouterModel(openrouter, model, reasoningEffort);
  if (!model.startsWith("openai/")) return primary;
  // Where OpenRouter would reject OpenAI, pick MiniMax M3 before the request.
  // The country lookup is async and getModel() is sync, so it runs per call.
  const fallback = openRouterModel(openrouter, MINIMAX_M3, reasoningEffort);
  const pick = async () => ((await openAiBlockedHere()) ? fallback : primary);
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ params }) => (await pick()).doGenerate(params),
      wrapStream: async ({ params }) => (await pick()).doStream(params),
    },
  });
}

/**
 * The model and cost reader for one-shot AI features (website setup research,
 * prompt suggestions, Prompt Research relevance), from the same env SAM uses.
 * With OPENROUTER_BASE_URL set (outside hosted mode), requests go to that
 * self-hosted endpoint and no key is needed. OpenRouter must report a cost
 * for every step, since hosted billing meters it; a self-hosted endpoint
 * reports none, so its spend reads as $0 instead of failing the run.
 */
export async function buildAiFeatureModel(reasoningEffort: "max" | "low") {
  const config = {
    apiKey: await getOptionalEnvValue("OPENROUTER_API_KEY"),
    modelId: await getOptionalEnvValue("OPENROUTER_MODEL"),
    baseURL: await getOptionalEnvValue("OPENROUTER_BASE_URL"),
    authMode: await getOptionalEnvValue("AUTH_MODE"),
  };
  return {
    model: buildChatAgentModel(config, reasoningEffort),
    costUsd: selfHostedBaseUrl(config)
      ? openRouterCostUsd
      : requireOpenRouterCostUsd,
  };
}

function openRouterModel(
  openrouter: OpenRouterProvider,
  model: string,
  reasoningEffort: "max" | "low",
): LanguageModelV3 {
  // MiniMax M3 (env override or OpenAI fallback): `provider.order` prefers
  // Together, then Atlas Cloud (fp8); `zdr: true` restricts routing to Zero-Data-
  // Retention endpoints, which excludes MiniMax first-party — the account's
  // "Non-frontier requires ZDR" data policy enforces the same, this flag is
  // belt-and-braces. Fallbacks stay on within the ZDR set because pinning
  // providers caused a prod outage (Jul 2026: Together upstream-rate-limited
  // m3 and every chat turn 429'd). The explicit reasoning channel keeps m3's
  // `<think>` trace out of the visible answer text.
  if (model === MINIMAX_M3) {
    return openrouter(model, {
      usage: { include: true },
      reasoning: { effort: reasoningEffort === "low" ? "low" : "medium" },
      provider: {
        order: ["together", "atlas-cloud/fp8"],
        zdr: true,
        allow_fallbacks: true,
      },
    });
  }

  return openrouter(model, {
    usage: { include: true },
    extraBody: { reasoning: { effort: reasoningEffort } },
  });
}

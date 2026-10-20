import { AUTH_MODES } from "@/lib/auth-mode";
import {
  looksLikeDataForSeoKey,
  MIN_BETTER_AUTH_SECRET_LENGTH,
  validateTeamDomain,
} from "@/shared/selfhost-checks";

// Startup preflight for self-host containers: validate the environment BEFORE
// the multi-minute build/boot so misconfiguration fails in seconds with the
// exact fix, instead of surfacing minutes later as a generic in-app error.
// "fail" aborts startup; "warn" degrades a feature; "info" is orientation.

type PreflightLevel = "ok" | "info" | "warn" | "fail";

type PreflightItem = {
  // Stable identifier shared with /api/health's check map.
  key: "auth" | "dataforseo" | "gsc" | "ai" | "rendering" | "runtime";
  name: string;
  level: PreflightLevel;
  message: string;
};

type PreflightResult = {
  items: PreflightItem[];
  failed: boolean;
};

type EnvRecord = Record<string, string | undefined>;

function get(env: EnvRecord, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function checkAuthMode(env: EnvRecord, items: PreflightItem[]): void {
  const rawMode = get(env, "AUTH_MODE");

  if (rawMode && !(AUTH_MODES as readonly string[]).includes(rawMode)) {
    items.push({
      key: "auth",
      name: "AUTH_MODE",
      level: "fail",
      message: `"${rawMode}" is not a valid AUTH_MODE. Valid values: ${AUTH_MODES.join(", ")}.`,
    });
    return;
  }

  const mode = rawMode ?? "cloudflare_access";

  if (mode === "local_noauth") {
    items.push({
      key: "auth",
      name: "AUTH_MODE",
      level: "ok",
      message:
        "local_noauth — no auth, single admin user. Do not expose publicly without your own auth in front.",
    });
    return;
  }

  if (mode === "hosted") {
    const missing = [
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ].filter((name) => !get(env, name));
    items.push(
      missing.length
        ? {
            key: "auth",
            name: "AUTH_MODE",
            level: "fail",
            message: `hosted mode requires ${missing.join(", ")}.`,
          }
        : { key: "auth", name: "AUTH_MODE", level: "ok", message: "hosted" },
    );
    return;
  }

  // cloudflare_access (explicit or defaulted)
  const teamDomain = get(env, "TEAM_DOMAIN");
  const policyAud = get(env, "POLICY_AUD");
  const modeLabel = rawMode
    ? "cloudflare_access"
    : "cloudflare_access (default — AUTH_MODE is unset)";

  if (!teamDomain || !policyAud) {
    const missing = [
      teamDomain ? null : "TEAM_DOMAIN",
      policyAud ? null : "POLICY_AUD",
    ]
      .filter(Boolean)
      .join(" and ");
    items.push({
      key: "auth",
      name: "AUTH_MODE",
      level: "fail",
      message: `${modeLabel} requires ${missing}. See docs/SELF_HOSTING_CLOUDFLARE.md — or set AUTH_MODE=local_noauth for a private, no-auth deployment.`,
    });
    return;
  }

  const teamDomainResult = validateTeamDomain(teamDomain);
  if (!teamDomainResult.ok) {
    items.push({
      key: "auth",
      name: "TEAM_DOMAIN",
      level: "fail",
      message: teamDomainResult.message,
    });
    return;
  }

  items.push({
    key: "auth",
    name: "AUTH_MODE",
    level: "ok",
    message: modeLabel,
  });
}

function checkDataForSeo(env: EnvRecord, items: PreflightItem[]): void {
  const key = get(env, "DATAFORSEO_API_KEY");

  if (!key) {
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_API_KEY",
      level: "warn",
      message:
        "Not set — all SEO data features will be unavailable until it is. It is the base64 of your DataForSEO login:password (NOT the dashboard API key). See docs/DATAFORSEO_API_KEY.md.",
    });
    return;
  }

  if (!looksLikeDataForSeoKey(key)) {
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_API_KEY",
      level: "warn",
      message:
        "Set, but does not decode as base64 of login:password. If DataForSEO rejects it, encode your account email and API password: printf 'email:password' | base64.",
    });
    return;
  }

  items.push({
    key: "dataforseo",
    name: "DATAFORSEO_API_KEY",
    level: "ok",
    message: "Set",
  });
}

function checkOptionalFeatures(env: EnvRecord, items: PreflightItem[]): void {
  const clientId = get(env, "GOOGLE_CLIENT_ID");
  const clientSecret = get(env, "GOOGLE_CLIENT_SECRET");
  const betterAuthSecret = get(env, "BETTER_AUTH_SECRET");

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "warn",
        message:
          "Only one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is set — both are required.",
      });
    } else if (
      !betterAuthSecret ||
      betterAuthSecret.length < MIN_BETTER_AUTH_SECRET_LENGTH
    ) {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "warn",
        message: `Google credentials are set, but Search Console stays DISABLED until BETTER_AUTH_SECRET is at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters (it encrypts stored OAuth tokens).`,
      });
    } else {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "ok",
        message: "Configured",
      });
    }
  } else {
    items.push({
      key: "gsc",
      name: "Search Console",
      level: "info",
      message:
        "Not configured (optional). See docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md.",
    });
  }

  items.push(
    get(env, "OPENROUTER_API_KEY")
      ? {
          key: "ai",
          name: "AI features",
          level: "ok",
          message: "OPENROUTER_API_KEY set",
        }
      : get(env, "OPENROUTER_BASE_URL")
        ? {
            key: "ai",
            name: "AI features",
            level: "ok",
            message:
              "OPENROUTER_BASE_URL set — SAM uses a self-hosted OpenAI-compatible endpoint (set OPENROUTER_MODEL to a model it serves). AI setup research, Prompt Research, and prompt suggestions still need OPENROUTER_API_KEY.",
          }
        : {
            key: "ai",
            name: "AI features",
            level: "info",
            message:
              "OPENROUTER_API_KEY not set (optional) — SAM, the in-app SEO agent, AI setup research, and Prompt Research are disabled. To run SAM on a self-hosted OpenAI-compatible endpoint instead, set OPENROUTER_BASE_URL and OPENROUTER_MODEL.",
          },
  );

  items.push(
    get(env, "CONTEXT_API_KEY")
      ? {
          key: "rendering",
          name: "JavaScript rendering",
          level: "ok",
          message: "CONTEXT_API_KEY set",
        }
      : {
          key: "rendering",
          name: "JavaScript rendering",
          level: "info",
          message:
            'CONTEXT_API_KEY not set (optional) — on Docker the site audit "Render JavaScript" option is disabled; on Cloudflare, Browser Run renders without a fallback.',
        },
  );
}

// Shared per-feature checks: the Docker preflight prints these at boot and
// /api/health (setup-status.ts) serves the same results at runtime, so the
// two can never drift.
export function runSelfhostChecks(env: EnvRecord): PreflightItem[] {
  const items: PreflightItem[] = [];
  checkAuthMode(env, items);
  checkDataForSeo(env, items);
  checkOptionalFeatures(env, items);
  return items;
}

export function runSelfhostPreflight(env: EnvRecord): PreflightResult {
  const items = runSelfhostChecks(env);

  items.push(
    get(env, "ALLOWED_HOST")
      ? {
          key: "runtime",
          name: "ALLOWED_HOST",
          level: "ok",
          message: `Requests allowed for host ${get(env, "ALLOWED_HOST")}`,
        }
      : {
          key: "runtime",
          name: "ALLOWED_HOST",
          level: "info",
          message:
            'Not set — only localhost and raw IP addresses are accepted. Behind a reverse proxy, tunnel, or a DNS name (e.g. a Tailscale MagicDNS name), set ALLOWED_HOST=yourdomain.com (comma-separate several) or requests are blocked with Vite\'s "Blocked request" page.',
        },
  );

  items.push({
    key: "runtime",
    name: "Scheduled checks",
    level: "info",
    message:
      "The built-in scheduler runs due rank-tracking and AI Visibility checks every five minutes while the container is running.",
  });

  return { items, failed: items.some((item) => item.level === "fail") };
}

const LEVEL_BADGES: Record<PreflightLevel, string> = {
  ok: "[ ok ]",
  info: "[info]",
  warn: "[warn]",
  fail: "[FAIL]",
};

export function formatPreflightReport(result: PreflightResult): string {
  const lines = result.items.map(
    (item) => `${LEVEL_BADGES[item.level]} ${item.name}: ${item.message}`,
  );

  lines.push(
    result.failed
      ? "\nPreflight failed — fix the [FAIL] items above and restart. Nothing was started."
      : "\nPreflight passed. On first start (or after an image update or build-env change) the app builds inside the container for ~1-2 minutes before it serves; later restarts reuse that build.",
  );

  return lines.join("\n");
}

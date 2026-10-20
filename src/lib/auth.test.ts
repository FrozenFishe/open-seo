import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHostedBaseUrl, hasHostedAuthConfig } from "@/lib/auth";

const env = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock("cloudflare:workers", () => ({ env }));

const configuredHostedEnv = {
  BETTER_AUTH_URL: "https://app.example.com",
  BETTER_AUTH_SECRET: "x".repeat(32),
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  BYPASS_EMAIL_VERIFICATION: "true",
};

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, configuredHostedEnv);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getHostedBaseUrl", () => {
  it("accepts http on portless *.localhost hosts", () => {
    env.BETTER_AUTH_URL = "http://feature.open-seo.localhost:1355";
    expect(getHostedBaseUrl()).toBe("http://feature.open-seo.localhost:1355");
  });

  it("rejects http on public hosts", () => {
    env.BETTER_AUTH_URL = "http://app.example.com";
    expect(() => getHostedBaseUrl()).toThrow();
  });
});

describe("hasHostedAuthConfig", () => {
  it("names the missing Turnstile secret", () => {
    env.TURNSTILE_SITE_KEY = "site-key";

    expect(hasHostedAuthConfig()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("TURNSTILE_SECRET_KEY is required"),
    );
  });

  it("passes without logging when hosted config is complete", () => {
    expect(hasHostedAuthConfig()).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/server/lib/errors";
import {
  isCrawlableUrl,
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "@/server/lib/audit/url-policy";

describe("isCrawlableUrl", () => {
  it.each([
    "http://127.0.0.1/",
    // Decimal, hex and octal IPv4 forms the URL parser normalizes to 127.0.0.1.
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::127.0.0.1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[64:ff9b::10.0.0.1]/",
    "http://[2002:c0a8:0001::1]/",
    "http://[fec0::1]/",
    "http://[fe80::1]/",
    "http://[fd12:3456::1]/",
    "http://localhost:3000/",
    "http://printer.local/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "not a url",
  ])("blocks %s", (url) => {
    expect(isCrawlableUrl(url)).toBe(false);
  });

  it.each([
    "https://example.com/page",
    "http://93.184.216.34/",
    "http://[2606:4700:4700::1111]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[64:ff9b::8.8.8.8]/",
    "http://[2002:808:808::1]/",
  ])("allows %s", (url) => {
    expect(isCrawlableUrl(url)).toBe(true);
  });
});

const dnsAnswer = (answers: { type: number; data: string }[] = []) =>
  new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });

describe("normalizeAndValidateStartUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https when protocol is missing and strips hash", async () => {
    vi.mocked(fetch).mockImplementation(async () => dnsAnswer());

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it.each(["http://localhost:3000", "http://192.168.0.10"])(
    "blocks %s",
    async (url) => {
      await expect(normalizeAndValidateStartUrl(url)).rejects.toMatchObject({
        code: "CRAWL_TARGET_BLOCKED",
      } satisfies Partial<AppError>);
    },
  );

  it("blocks a hostname that resolves to an embedded private address", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      (input instanceof Request ? input.url : input.toString()).includes(
        "type=AAAA",
      )
        ? dnsAnswer([{ type: 28, data: "64:ff9b::a00:1" }])
        : dnsAnswer(),
    );

    await expect(
      normalizeAndValidateStartUrl("https://rebind.example/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });

  it.each([
    ["the lookup errors", () => Promise.reject(new Error("timeout"))],
    ["the resolver refuses", async () => new Response(null, { status: 503 })],
  ])("blocks a hostname when %s", async (_case, respond) => {
    vi.mocked(fetch).mockImplementation(respond);

    await expect(
      normalizeAndValidateStartUrl("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });
});

const dnsOk = () =>
  new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
const redirect = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

describe("resolveStartUrlRedirects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route probe fetches by URL; DoH lookups always resolve clean. */
  function stubFetch(routes: Record<string, () => Response>) {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("dns-query")) return Promise.resolve(dnsOk());
      const route = routes[url];
      return route
        ? Promise.resolve(route())
        : Promise.resolve(new Response(null, { status: 200 }));
    });
  }

  it("follows a cross-domain redirect to the real origin", async () => {
    stubFetch({
      "https://example.net/": () => redirect("https://example.com/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.net/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("returns the last URL when the probe fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("stops after the hop limit on a redirect loop", async () => {
    stubFetch({
      "https://a.example/": () => redirect("https://b.example/"),
      "https://b.example/": () => redirect("https://a.example/"),
    });
    const resolved = await resolveStartUrlRedirects("https://a.example/");
    expect(resolved.url).toMatch(/^https:\/\/(a|b)\.example\/$/);
  });

  it("rejects redirects into blocked targets", async () => {
    stubFetch({
      "https://example.com/": () => redirect("http://192.168.0.10/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });
});

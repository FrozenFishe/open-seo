import { AppError } from "@/server/lib/errors";
import { crawlerHeadersFor, type CrawlerAccess } from "@/shared/crawler-access";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.includes("%")) {
    host = host.split("%", 1)[0];
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

function parseIpv4(host: string): number[] | null {
  const parts = normalizeHost(host).split(".");
  if (parts.length !== 4 || parts.some((x) => !/^\d{1,3}$/.test(x))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((x) => x <= 255) ? octets : null;
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) return false;

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/** Parses an IPv6 literal into its eight 16-bit groups, or null. */
function parseIpv6(host: string): number[] | null {
  let value = normalizeHost(host);
  if (!value.includes(":")) return null;

  // A trailing dotted quad fills the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) {
    const octets = parseIpv4(dotted[2]);
    if (!octets) return null;
    const [a, b, c, d] = octets;
    value = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * IPv6 forms that carry an IPv4 address the network may route to: mapped
 * (::ffff:0:0/96), translated (::ffff:0:0:0/96), compatible (::/96), NAT64
 * (64:ff9b::/96) and 6to4 (2002::/16).
 */
function embeddedIpv4(groups: number[]): string | null {
  const zeroes = (from: number, to: number) =>
    groups.slice(from, to).every((group) => group === 0);
  if (zeroes(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) {
    return ipv4FromGroups(groups[6], groups[7]);
  }
  if (zeroes(0, 4) && groups[4] === 0xffff && groups[5] === 0) {
    return ipv4FromGroups(groups[6], groups[7]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeroes(2, 6)) {
    return ipv4FromGroups(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) {
    return ipv4FromGroups(groups[1], groups[2]);
  }
  return null;
}

function isPrivateIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;

  const embedded = embeddedIpv4(groups);
  // ::1 and :: land here as 0.0.0.1 and 0.0.0.0.
  if (embedded) return isPrivateIpv4(embedded);

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  // Local-use NAT64 (64:ff9b:1::/48) translates into the operator's network.
  if (first === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true;
  return false;
}

function isIpLiteral(host: string): boolean {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  if (isIpLiteral(host)) {
    return isPrivateIpv4(host) || isPrivateIpv6(host);
  }

  return false;
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

async function resolveAddressRecords(
  hostname: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  const response = await fetch(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
    {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(2_500),
    },
  );

  if (!response.ok) throw new Error(`DoH lookup failed: ${response.status}`);

  const body: DnsJsonResponse = await response.json();
  // NXDOMAIN is a real answer: the name has no address to reach. Any other
  // failure (SERVFAIL, REFUSED) leaves the address unknown.
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new Error(`DoH lookup failed: ${body.Status}`);
  if (!Array.isArray(body.Answer)) return [];

  const expectedType = type === "A" ? 1 : 28;
  return body.Answer.filter(
    (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
      answer.type === expectedType && typeof answer.data === "string",
  ).map((answer) => normalizeHost(answer.data));
}

/**
 * Fails closed: when the lookup cannot complete, the host is treated as
 * blocked, since an unverified name may point anywhere.
 */
async function hostnameResolvesToBlockedAddress(
  hostname: string,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;

  let addresses: string[];
  try {
    const [v4, v6] = await Promise.all([
      resolveAddressRecords(host, "A"),
      resolveAddressRecords(host, "AAAA"),
    ]);
    addresses = [...v4, ...v6];
  } catch {
    return true;
  }

  return addresses.some(
    (address) => isPrivateIpv4(address) || isPrivateIpv6(address),
  );
}

/**
 * Shopify storefronts, custom domains included, resolve into Shopify's
 * 23.227.38.0/24. This identifies a store even when its edge answers with a
 * bare 429 that carries no `powered-by` header.
 */
export async function isShopifyHost(hostname: string): Promise<boolean> {
  try {
    const addresses = await resolveAddressRecords(normalizeHost(hostname), "A");
    return addresses.some((address) => address.startsWith("23.227.38."));
  } catch {
    return false;
  }
}

/**
 * Synchronous SSRF check for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries). Blocks non-http(s) schemes, private/loopback IP
 * literals, and internal hostnames. DNS resolution is only performed for the
 * start URL (see normalizeAndValidateStartUrl); per-link DoH lookups would be
 * prohibitively slow.
 */
export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return !isBlockedHost(parsed.hostname);
}

export async function normalizeAndValidateStartUrl(
  input: string,
): Promise<string> {
  let raw = input.trim();
  if (!raw) throw new AppError("VALIDATION_ERROR");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR");
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (…net -> …com, apex -> www) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation (SSRF, blocked hosts), so
 * a redirect can't smuggle the audit somewhere the user couldn't have
 * pointed it directly. Probe failures (timeouts, HEAD rejected) fall back
 * to the last validated URL — the crawl records the real fetch result.
 *
 * Also reports the final response's `powered-by` header, which is how a
 * Shopify storefront identifies itself.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
  access?: CrawlerAccess | null,
): Promise<{ url: string; poweredBy: string | null }> {
  let current = startUrl;
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: {
          "User-Agent": "OpenSEO-Audit/1.0",
          ...crawlerHeadersFor(current, access),
        },
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return { url: current, poweredBy: null };
    }
    if (response.status < 300 || response.status >= 400) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }
    const location = response.headers.get("location");
    if (!location) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { url: current, poweredBy: null };
    }
    current = await normalizeAndValidateStartUrl(next.toString());
  }
  return { url: current, poweredBy: null };
}

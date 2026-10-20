import { z } from "zod";

// Kept apart from researchScope.ts, which needs the public-suffix list
// (tldts, ~100 KB). Route search schemas only need the scope values, and they
// load with the app's entry chunk.

/**
 * Research scope for any URL/domain input:
 * - exact_url:  one normalized page URL only
 * - subfolder:  the selected path and its children (not similarly named siblings)
 * - domain:     the selected hostname, excluding its subdomains
 * - subdomains: the selected hostname and all of its subdomains
 */
export const RESEARCH_SCOPES = [
  "exact_url",
  "subfolder",
  "domain",
  "subdomains",
] as const;

export type ResearchScope = (typeof RESEARCH_SCOPES)[number];

export const researchScopeSchema = z.enum(RESEARCH_SCOPES);

/** Base wording for MCP `scope` params; tools append their own caveats. */
export const RESEARCH_SCOPE_PARAM_DESCRIPTION =
  "Research scope: 'domain' (hostname without subdomains), 'subdomains' (hostname plus all subdomains), 'subfolder' (path and its children), or 'exact_url' (one page). Defaults to 'subdomains' for root inputs and 'subfolder' when the input has a path.";

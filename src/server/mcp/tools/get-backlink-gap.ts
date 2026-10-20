import { sort } from "remeda";
import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { joinClauses } from "@/server/lib/dataforseo/filters";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  DEFAULT_GAP_LIMIT,
  gapDomainInputs,
  paginationInputs,
  resolveGapDomains,
} from "@/server/mcp/tools/gap-tool-shared";
import { creditsForProviderUsd } from "@/shared/billing";
import { DEFAULT_BACKLINKS_SPAM_THRESHOLD } from "@/types/schemas/backlinks";

// The cost hint comes from the estimator the metering seam reserves with, so
// the description cannot drift from what a default call holds.
const CALL_CREDITS = creditsForProviderUsd(
  dataforseoPricing.backlinks.domainIntersection({
    targets: [],
    limit: DEFAULT_GAP_LIMIT,
  }),
);

const backlinkGapInputSchema = {
  ...gapDomainInputs,
  hideSpam: z
    .boolean()
    .optional()
    .describe(
      `Hide referring domains whose links to a competitor average a spam score of ${DEFAULT_BACKLINKS_SPAM_THRESHOLD} or higher. Defaults to true. Unknown scores remain visible.`,
    ),
  minDomainRank: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Only return referring domains with at least this rank (0-100)."),
  ...paginationInputs,
} as const;

type BacklinkGapArgs = z.infer<z.ZodObject<typeof backlinkGapInputSchema>>;

const backlinkGapRowSchema = z.looseObject({
  referringDomain: z.string(),
  domainRank: z.number().nullable(),
  spamScore: z.number().nullable(),
  competitors: z.array(
    z.looseObject({
      domain: z.string(),
      backlinks: z.number().nullable(),
      rank: z.number().nullable(),
      spamScore: z.number().nullable(),
    }),
  ),
});

type BacklinkGapRow = z.infer<typeof backlinkGapRowSchema>;

function maxOrNull(values: Array<number | null>): number | null {
  const known = values.filter((value) => value != null);
  return known.length > 0 ? Math.max(...known) : null;
}

export const getBacklinkGapTool = {
  name: "get_backlink_gap",
  config: {
    title: "Get backlink gap",
    description: `Finds referring domains that link to 1-3 competitor domains but not to the target, in one call instead of diffing referring domains per site. Rows carry the referring domain's rank (0-100), spam score, and which competitors it links to with backlink counts; strongest domains first. Target and competitors default to the project's website and saved competitors. Charges credits: up to ~${CALL_CREDITS} per competitor at the default 50 rows; larger limit/offset costs more. Self-hosted deployments need the Backlinks API enabled on their DataForSEO account.`,
    inputSchema: backlinkGapInputSchema,
    outputSchema: z.looseObject({
      target: z.string(),
      competitors: z.array(z.string()),
      referringDomains: z.array(backlinkGapRowSchema),
      hasMore: z.boolean(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BacklinkGapArgs, context) => {
    const { target, competitors } = await resolveGapDomains(
      args,
      context.project,
    );
    const limit = args.limit ?? DEFAULT_GAP_LIMIT;
    const offset = args.offset ?? 0;
    const conditions: unknown[][] = [];
    if (args.hideSpam ?? true) {
      conditions.push([
        ["1.backlinks_spam_score", "<", DEFAULT_BACKLINKS_SPAM_THRESHOLD],
        "or",
        ["1.backlinks_spam_score", "=", null],
      ]);
    }
    if (args.minDomainRank != null) {
      conditions.push(["1.rank", ">=", args.minDomainRank]);
    }
    const fetchLimit = offset + limit;

    const client = createDataforseoClient(context.billing);
    // One call per competitor, each excluding the target: the provider's
    // multi-target semantics (intersect vs merge) aren't documented precisely.
    const pages = await Promise.all(
      competitors.map(async (competitor) => ({
        competitor,
        page: await client.backlinks.domainIntersection({
          targets: [competitor],
          excludeTargets: [target],
          limit: fetchLimit,
          orderBy: ["1.rank,desc"],
          filters: joinClauses(conditions, "and"),
        }),
      })),
    );

    const merged = new Map<string, BacklinkGapRow>();
    for (const { competitor, page } of pages) {
      for (const item of page.items) {
        const entry = item.domain_intersection?.["1"];
        const referringDomain = entry?.target;
        if (!referringDomain) continue;
        const row = merged.get(referringDomain) ?? {
          referringDomain,
          domainRank: null,
          spamScore: null,
          competitors: [],
        };
        row.competitors.push({
          domain: competitor,
          backlinks: entry.backlinks ?? null,
          rank: entry.rank ?? null,
          spamScore: entry.backlinks_spam_score ?? null,
        });
        row.domainRank = maxOrNull(row.competitors.map((link) => link.rank));
        row.spamScore = maxOrNull(
          row.competitors.map((link) => link.spamScore),
        );
        merged.set(referringDomain, row);
      }
    }

    const sorted = sort(
      [...merged.values()],
      (a, b) =>
        (b.domainRank ?? -1) - (a.domainRank ?? -1) ||
        b.competitors.length - a.competitors.length ||
        a.referringDomain.localeCompare(b.referringDomain),
    );
    const referringDomains = sorted.slice(offset, offset + limit);
    const hasMore =
      sorted.length > offset + limit ||
      pages.some(
        ({ page }) => page.totalCount != null && page.totalCount > fetchLimit,
      );

    const columns: McpTableColumn<BacklinkGapRow>[] = [
      { header: "referring domain", value: (row) => row.referringDomain },
      { header: "rank", value: (row) => row.domainRank },
      { header: "spam", value: (row) => row.spamScore },
      ...competitors.map((domain) => ({
        header: `${domain} links`,
        value: (row: BacklinkGapRow) =>
          row.competitors.find((link) => link.domain === domain)?.backlinks,
      })),
    ];
    const header = `Backlink gap for ${target} vs ${competitors.join(", ")}: ${referringDomains.length} referring domains that link to a competitor but not to ${target}${hasMore ? ", more available" : ""}. rank = referring domain rank (0-100), spam = highest average spam score of its links to a competitor; "—" = no links found to that competitor.`;
    return mcpResponse({
      text:
        referringDomains.length === 0
          ? header
          : `${header}\n${formatMcpTable(referringDomains, columns)}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/backlinks`,
        { target },
      ),
      structuredContent: {
        target,
        competitors,
        referringDomains,
        hasMore,
      },
    });
  }),
};

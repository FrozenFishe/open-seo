import { sort } from "remeda";
import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { joinClauses } from "@/server/lib/dataforseo/filters";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { languageCodeSchema, locationCodeSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  DEFAULT_GAP_LIMIT,
  gapDomainInputs,
  paginationInputs,
  resolveGapDomains,
} from "@/server/mcp/tools/gap-tool-shared";
import { creditsForProviderUsd } from "@/shared/billing";
import { resolveLabsMarket } from "@/shared/keyword-locations";

const DEFAULT_MAX_COMPETITOR_RANK = 20;

// The cost hint comes from the estimator the metering seam reserves with, so
// the description cannot drift from what a default call holds.
const CALL_CREDITS = creditsForProviderUsd(
  dataforseoPricing.domain.intersection({
    target1: "",
    target2: "",
    intersections: false,
    locationCode: 0,
    languageCode: "",
    limit: DEFAULT_GAP_LIMIT,
  }),
);

const keywordGapSortSchema = z.enum([
  "search_volume",
  "cpc",
  "keyword_difficulty",
]);

const keywordGapInputSchema = {
  ...gapDomainInputs,
  locationCode: locationCodeSchema
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market.",
    ),
  languageCode: languageCodeSchema.optional(),
  minSearchVolume: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only return keywords with at least this monthly search volume."),
  maxCompetitorRank: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      `Only count a competitor ranking at this organic position or better. Defaults to ${DEFAULT_MAX_COMPETITOR_RANK}.`,
    ),
  includeWeaker: z
    .boolean()
    .optional()
    .describe(
      "Also return keywords the target ranks for, but below a competitor. Defaults to true; false returns only keywords the target doesn't rank for and halves the cost.",
    ),
  sortBy: keywordGapSortSchema
    .optional()
    .describe(
      "Opportunity order: search_volume (default, highest first), cpc (highest first), or keyword_difficulty (easiest first).",
    ),
  ...paginationInputs,
} as const;

type KeywordGapArgs = z.infer<z.ZodObject<typeof keywordGapInputSchema>>;
type KeywordGapSort = z.infer<typeof keywordGapSortSchema>;

const KEYWORD_GAP_ORDER_BY: Record<KeywordGapSort, string> = {
  search_volume: "keyword_data.keyword_info.search_volume,desc",
  cpc: "keyword_data.keyword_info.cpc,desc",
  keyword_difficulty: "keyword_data.keyword_properties.keyword_difficulty,asc",
};

const competitorRankSchema = z.looseObject({
  domain: z.string(),
  rank: z.number().nullable(),
  url: z.string().nullable(),
});

const keywordGapRowSchema = z.looseObject({
  keyword: z.string(),
  gap: z.enum(["missing", "weaker"]),
  searchVolume: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
  cpc: z.number().nullable(),
  intent: z.string().nullable(),
  targetRank: z.number().nullable(),
  targetUrl: z.string().nullable(),
  competitors: z.array(competitorRankSchema),
});

type KeywordGapRow = z.infer<typeof keywordGapRowSchema>;

type MergedKeyword = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  intent: string | null;
  targetRank: number | null;
  targetUrl: string | null;
  ranks: Map<string, { rank: number | null; url: string | null }>;
};

function bestRank(ranks: MergedKeyword["ranks"]) {
  let best: number | null = null;
  for (const { rank } of ranks.values()) {
    if (rank != null && (best == null || rank < best)) best = rank;
  }
  return best;
}

function rankedCompetitorCount(row: KeywordGapRow) {
  return row.competitors.filter((entry) => entry.rank != null).length;
}

function compareKeywordGapRows(sortBy: KeywordGapSort) {
  return (a: KeywordGapRow, b: KeywordGapRow) => {
    let primary: number;
    if (sortBy === "keyword_difficulty") {
      // Easiest first; unknown difficulty sorts last.
      primary =
        (a.keywordDifficulty ?? Number.POSITIVE_INFINITY) -
        (b.keywordDifficulty ?? Number.POSITIVE_INFINITY);
    } else {
      const field = sortBy === "cpc" ? "cpc" : "searchVolume";
      primary = (b[field] ?? -1) - (a[field] ?? -1);
    }
    if (Number.isFinite(primary) && primary !== 0) return primary;
    return (
      rankedCompetitorCount(b) - rankedCompetitorCount(a) ||
      a.keyword.localeCompare(b.keyword)
    );
  };
}

export const getKeywordGapTool = {
  name: "get_keyword_gap",
  config: {
    title: "Get keyword gap",
    description: `Finds keywords 1-3 competitor domains rank for organically (within maxCompetitorRank, default 20) that the target doesn't rank for, or ranks below them for, in one call instead of diffing get_ranked_keywords per domain. Rows carry search volume, keyword difficulty, CPC, intent, each competitor's rank and URL, and the target's rank (null = not ranking). Target and competitors default to the project's website and saved competitors. Charges credits: up to ~${2 * CALL_CREDITS} per competitor at the default 50 rows (~${CALL_CREDITS} with includeWeaker false); larger limit/offset costs more.`,
    inputSchema: keywordGapInputSchema,
    outputSchema: z.looseObject({
      target: z.string(),
      competitors: z.array(z.string()),
      locationCode: z.number(),
      languageCode: z.string(),
      keywords: z.array(keywordGapRowSchema),
      hasMore: z.boolean(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: KeywordGapArgs, context) => {
    const { target, competitors } = await resolveGapDomains(
      args,
      context.project,
    );
    const market = resolveLabsMarket(args, context.project);
    assertLabsLocationCode(market.locationCode);
    assertLanguageForLocation(market.locationCode, market.languageCode);

    const limit = args.limit ?? DEFAULT_GAP_LIMIT;
    const offset = args.offset ?? 0;
    const sortBy = args.sortBy ?? "search_volume";
    const maxRank = args.maxCompetitorRank ?? DEFAULT_MAX_COMPETITOR_RANK;
    const conditions: unknown[][] = [
      ["first_domain_serp_element.rank_absolute", "<=", maxRank],
    ];
    if (args.minSearchVolume != null) {
      conditions.push([
        "keyword_data.keyword_info.search_volume",
        ">=",
        args.minSearchVolume,
      ]);
    }
    const request = {
      target2: target,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      limit: offset + limit,
      orderBy: [KEYWORD_GAP_ORDER_BY[sortBy]],
      filters: joinClauses(conditions, "and"),
      itemTypes: ["organic" as const],
    };
    const modes = args.includeWeaker === false ? [false] : [false, true];

    const client = createDataforseoClient(context.billing);
    const pages = await Promise.all(
      competitors.flatMap((competitor) =>
        modes.map(async (intersections) => ({
          competitor,
          intersections,
          page: await client.domain.intersection({
            ...request,
            target1: competitor,
            intersections,
          }),
        })),
      ),
    );

    const merged = new Map<string, MergedKeyword>();
    for (const { competitor, intersections, page } of pages) {
      for (const item of page.items) {
        const data = item.keyword_data;
        const keyword = data?.keyword;
        if (!keyword) continue;
        const targetElement = intersections
          ? item.second_domain_serp_element
          : null;
        const row = merged.get(keyword) ?? {
          keyword,
          searchVolume: data.keyword_info?.search_volume ?? null,
          keywordDifficulty:
            data.keyword_properties?.keyword_difficulty ?? null,
          cpc: data.keyword_info?.cpc ?? null,
          intent: data.search_intent_info?.main_intent ?? null,
          targetRank: null,
          targetUrl: null,
          ranks: new Map(),
        };
        if (targetElement?.rank_absolute != null) {
          row.targetRank = targetElement.rank_absolute;
          row.targetUrl = targetElement.url ?? null;
        }
        row.ranks.set(competitor, {
          rank: item.first_domain_serp_element?.rank_absolute ?? null,
          url: item.first_domain_serp_element?.url ?? null,
        });
        merged.set(keyword, row);
      }
    }

    const gapRows: KeywordGapRow[] = [];
    for (const { ranks, ...row } of merged.values()) {
      const best = bestRank(ranks);
      // A shared keyword is a gap only when some competitor outranks the target.
      if (row.targetRank != null && (best == null || best >= row.targetRank)) {
        continue;
      }
      gapRows.push({
        ...row,
        gap: row.targetRank == null ? "missing" : "weaker",
        competitors: competitors.map((domain) => ({
          domain,
          rank: ranks.get(domain)?.rank ?? null,
          url: ranks.get(domain)?.url ?? null,
        })),
      });
    }
    const sorted = sort(gapRows, compareKeywordGapRows(sortBy));
    const keywords = sorted.slice(offset, offset + limit);
    const hasMore =
      sorted.length > offset + limit ||
      pages.some(
        ({ page }) =>
          page.totalCount != null && page.totalCount > request.limit,
      );

    const columns: McpTableColumn<KeywordGapRow>[] = [
      { header: "keyword", value: (row) => row.keyword },
      { header: "gap", value: (row) => row.gap },
      { header: "volume", value: (row) => row.searchVolume },
      { header: "KD", value: (row) => row.keywordDifficulty },
      { header: "CPC", value: (row) => row.cpc },
      { header: "intent", value: (row) => row.intent },
      { header: target, value: (row) => row.targetRank },
      ...competitors.map((domain, index) => ({
        header: domain,
        value: (row: KeywordGapRow) => row.competitors[index]?.rank,
      })),
    ];
    const header = `Keyword gap for ${target} vs ${competitors.join(", ")} (competitors in the top ${maxRank}; ${market.locationCode}/${market.languageCode}): ${keywords.length} rows${hasMore ? ", more available" : ""}. gap: missing = target doesn't rank, weaker = a competitor outranks the target. Domain columns are organic ranks; "—" = not ranking (competitors: not within the top ${maxRank}).`;
    return mcpResponse({
      text:
        keywords.length === 0
          ? header
          : `${header}\n${formatMcpTable(keywords, columns)}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        { domain: target },
      ),
      structuredContent: {
        target,
        competitors,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        keywords,
        hasMore,
      },
    });
  }),
};

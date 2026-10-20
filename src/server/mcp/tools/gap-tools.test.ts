import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBacklinkGapTool } from "./get-backlink-gap";
import { getKeywordGapTool } from "./get-keyword-gap";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
  listCompetitors: vi.fn(),
  intersection:
    vi.fn<
      (input: {
        target1: string;
        target2: string;
        intersections: boolean;
      }) => Promise<{ items: unknown[]; totalCount: number | null }>
    >(),
  domainIntersection:
    vi.fn<
      (input: {
        targets: string[];
      }) => Promise<{ items: unknown[]; totalCount: number | null }>
    >(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: { listCompetitors: mocks.listCompetitors },
  }),
);

const toolContext = makeToolContext();

function keywordItem(
  keyword: string,
  searchVolume: number,
  competitorRank: number,
  targetRank?: number,
) {
  return {
    keyword_data: { keyword, keyword_info: { search_volume: searchVolume } },
    first_domain_serp_element: {
      rank_absolute: competitorRank,
      url: `https://competitor.test/${keyword}`,
    },
    ...(targetRank == null
      ? {}
      : {
          second_domain_serp_element: {
            rank_absolute: targetRank,
            url: `https://example.com/${keyword}`,
          },
        }),
  };
}

function referringDomainItem(target: string, rank: number, backlinks: number) {
  return { domain_intersection: { "1": { target, rank, backlinks } } };
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.listCompetitors.mockResolvedValue([]);
  mocks.intersection.mockResolvedValue({ items: [], totalCount: 0 });
  mocks.domainIntersection.mockResolvedValue({ items: [], totalCount: 0 });
  mocks.createDataforseoClient.mockReturnValue({
    domain: { intersection: mocks.intersection },
    backlinks: { domainIntersection: mocks.domainIntersection },
  });
});

describe("get_keyword_gap", () => {
  it("merges missing and outranked keywords across competitors", async () => {
    mocks.intersection.mockImplementation(async (input) => {
      const pages: Record<string, unknown[]> = {
        "a.com:false": [keywordItem("alpha", 100, 3)],
        "a.com:true": [
          keywordItem("beta", 500, 4, 15),
          keywordItem("gamma", 900, 8, 2),
        ],
        "b.com:false": [keywordItem("alpha", 100, 7)],
        "b.com:true": [keywordItem("gamma", 900, 1, 2)],
      };
      return {
        items: pages[`${input.target1}:${input.intersections}`],
        totalCount: null,
      };
    });

    const result = await getKeywordGapTool.handler(
      {
        projectId: "project_1",
        competitors: ["a.com", "https://www.b.com"],
        minSearchVolume: 50,
        offset: 10,
        limit: 20,
      },
      toolContext,
    );

    expect(mocks.intersection).toHaveBeenCalledTimes(4);
    expect(mocks.intersection).toHaveBeenCalledWith(
      expect.objectContaining({
        target1: "b.com",
        target2: "example.com",
        intersections: false,
        limit: 30,
        itemTypes: ["organic"],
        orderBy: ["keyword_data.keyword_info.search_volume,desc"],
        filters: [
          ["first_domain_serp_element.rank_absolute", "<=", 20],
          "and",
          ["keyword_data.keyword_info.search_volume", ">=", 50],
        ],
      }),
    );
    // The page is cut from the merged list, so offset 10 skips past all three.
    expect(result.structuredContent.keywords).toEqual([]);

    const firstPage = await getKeywordGapTool.handler(
      { projectId: "project_1", competitors: ["a.com", "b.com"] },
      toolContext,
    );
    expect(
      firstPage.structuredContent.keywords.map((row) => ({
        keyword: row.keyword,
        gap: row.gap,
        targetRank: row.targetRank,
        ranks: row.competitors.map((entry) => entry.rank),
      })),
    ).toEqual([
      // gamma: the target outranks a.com but not b.com, so it is still a gap.
      { keyword: "gamma", gap: "weaker", targetRank: 2, ranks: [8, 1] },
      { keyword: "beta", gap: "weaker", targetRank: 15, ranks: [4, null] },
      { keyword: "alpha", gap: "missing", targetRank: null, ranks: [3, 7] },
    ]);
  });

  it("drops shared keywords where the target already outranks every competitor", async () => {
    mocks.intersection.mockImplementation(async (input) => ({
      items: input.intersections ? [keywordItem("delta", 900, 9, 2)] : [],
      totalCount: null,
    }));

    const result = await getKeywordGapTool.handler(
      { projectId: "project_1", competitors: ["a.com"] },
      toolContext,
    );

    expect(result.structuredContent.keywords).toEqual([]);
  });

  it("defaults to the project's website and first three saved competitors", async () => {
    mocks.listCompetitors.mockResolvedValue(
      ["www.example.com", "a.com", "b.com", "c.com", "d.com"].map((domain) => ({
        domain,
      })),
    );

    const result = await getKeywordGapTool.handler(
      { projectId: "project_1", includeWeaker: false },
      toolContext,
    );

    expect(mocks.listCompetitors).toHaveBeenCalledWith("project_1");
    expect(result.structuredContent.competitors).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(
      mocks.intersection.mock.calls.map(([input]) => [
        input.target1,
        input.target2,
        input.intersections,
      ]),
    ).toEqual([
      ["a.com", "example.com", false],
      ["b.com", "example.com", false],
      ["c.com", "example.com", false],
    ]);
  });

  it("refuses before any paid call when there are no competitors to compare", async () => {
    await expect(
      getKeywordGapTool.handler({ projectId: "project_1" }, toolContext),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "Pass competitors, or save some to the project with update_project_context.",
    });
    expect(mocks.intersection).not.toHaveBeenCalled();
  });
});

describe("get_backlink_gap", () => {
  it("merges referring domains missing from the target across competitors", async () => {
    mocks.domainIntersection.mockImplementation(async (input) => ({
      items:
        input.targets[0] === "a.com"
          ? [
              referringDomainItem("news.test", 80, 12),
              referringDomainItem("blog.test", 40, 3),
            ]
          : [referringDomainItem("blog.test", 55, 7)],
      totalCount: null,
    }));

    const result = await getBacklinkGapTool.handler(
      {
        projectId: "project_1",
        competitors: ["a.com", "b.com"],
        minDomainRank: 30,
      },
      toolContext,
    );

    expect(mocks.domainIntersection).toHaveBeenCalledWith({
      targets: ["a.com"],
      excludeTargets: ["example.com"],
      limit: 50,
      orderBy: ["1.rank,desc"],
      filters: [
        [
          ["1.backlinks_spam_score", "<", 40],
          "or",
          ["1.backlinks_spam_score", "=", null],
        ],
        "and",
        ["1.rank", ">=", 30],
      ],
    });
    expect(result.structuredContent.referringDomains).toEqual([
      expect.objectContaining({
        referringDomain: "news.test",
        domainRank: 80,
        competitors: [
          { domain: "a.com", backlinks: 12, rank: 80, spamScore: null },
        ],
      }),
      expect.objectContaining({
        referringDomain: "blog.test",
        domainRank: 55,
        competitors: [
          { domain: "a.com", backlinks: 3, rank: 40, spamScore: null },
          { domain: "b.com", backlinks: 7, rank: 55, spamScore: null },
        ],
      }),
    ]);
  });
});

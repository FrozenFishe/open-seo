import { z } from "zod";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { AppError } from "@/server/lib/errors";
import { projectIdSchema } from "@/server/mcp/schemas";

// Shared by get_keyword_gap and get_backlink_gap.

const MAX_COMPETITORS = 3;
export const DEFAULT_GAP_LIMIT = 50;
const MAX_LIMIT = 100;
// Each provider call fetches offset + limit rows (DataForSEO caps a page at
// 1,000), so the merged page is cut from complete per-competitor prefixes.
const MAX_OFFSET = 900;

const domainSchema = z.string().min(1).max(255);

export const gapDomainInputs = {
  projectId: projectIdSchema,
  target: domainSchema
    .optional()
    .describe(
      "Your domain (no protocol/www needed). Defaults to the project's website.",
    ),
  competitors: z
    .array(domainSchema)
    .min(1)
    .max(MAX_COMPETITORS)
    .optional()
    .describe(
      "1-3 competitor domains. Defaults to the first 3 competitors saved in the project context (see get_project_context).",
    ),
} as const;

export const paginationInputs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Maximum rows to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_GAP_LIMIT}.`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_OFFSET)
    .optional()
    .describe(
      `Rows to skip for pagination (0-${MAX_OFFSET}). Each provider call fetches offset + limit rows, so later pages cost more.`,
    ),
} as const;

/**
 * The bare hosts a gap tool compares: the explicit target or the project's
 * website, and the explicit competitors or the project's saved shortlist. The
 * target is never compared against itself.
 */
export async function resolveGapDomains(
  args: { projectId: string; target?: string; competitors?: string[] },
  project: { domain: string | null },
) {
  const rawTarget = args.target ?? project.domain;
  if (!rawTarget) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Pass target, or set the project's website first.",
    );
  }
  const target = normalizeDomainInput(rawTarget, true);
  const rawCompetitors =
    args.competitors ??
    (await ProjectContextRepository.listCompetitors(args.projectId)).map(
      (row) => row.domain,
    );
  const competitors = [
    ...new Set(
      rawCompetitors.map((domain) => normalizeDomainInput(domain, true)),
    ),
  ]
    .filter((domain) => domain !== target)
    .slice(0, MAX_COMPETITORS);
  if (competitors.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      args.competitors
        ? "Pass at least one competitor other than the target."
        : "Pass competitors, or save some to the project with update_project_context.",
    );
  }
  return { target, competitors };
}

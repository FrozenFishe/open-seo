import { z } from "zod";
import { isValidDomainHost } from "@/shared/researchScope";
import { normalizeDomain } from "@/types/schemas/domain";

// Not in domain.ts: route search schemas there load with the app's entry
// chunk, and isValidDomainHost pulls in the public-suffix list (tldts).

/** Zod field: accepts a bare domain or full URL, outputs a clean hostname. */
export const domainField = z
  .string()
  .min(1)
  .max(253)
  .transform((val, ctx) => {
    try {
      const hostname = normalizeDomain(val);
      if (!hostname.includes(".") || !isValidDomainHost(hostname)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid domain like example.com",
        });
        return z.NEVER;
      }
      return hostname;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid domain like example.com",
      });
      return z.NEVER;
    }
  });

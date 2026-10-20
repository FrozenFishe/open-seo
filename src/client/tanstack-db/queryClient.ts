import { MutationCache, QueryClient } from "@tanstack/query-core";
import { toast } from "sonner";
import {
  getErrorCode,
  getStandardErrorMessage,
} from "@/client/lib/error-messages";
import type { ErrorCode } from "@/shared/error-codes";

declare module "@tanstack/query-core" {
  interface Register {
    mutationMeta: {
      // Set when the component shows the error itself (inline or in a catch).
      errorToast?: false;
    };
  }
}

// Errors that can clear up on their own. A known error such as NOT_FOUND or
// FORBIDDEN gives the same answer on every retry, so the page would only show
// its error state seconds later.
const RETRYABLE_ERROR_CODES = new Set<ErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const queryClient = new QueryClient({
  // Every failed mutation shows a toast unless it has its own onError or opts
  // out through meta, so no failure is silent.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError || mutation.meta?.errorToast === false) {
        return;
      }
      toast.error(getStandardErrorMessage(error));
    },
  }),
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60,
      retry: (failureCount, error) => {
        const code = getErrorCode(error);
        return (
          failureCount < 3 && (code === null || RETRYABLE_ERROR_CODES.has(code))
        );
      },
      staleTime: 1000 * 60 * 5, // 5 minutes — show cached data instantly, refetch in background after
    },
  },
});

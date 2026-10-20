import { queryOptions } from "@tanstack/react-query";
import { getGa4DashboardReport } from "@/serverFunctions/ga4";
import { getSearchPerformanceReport } from "@/serverFunctions/searchPerformance";

/** The dashboard's 28-day Search Console report. `connected: false` from a
 *  saved connection means Google rejected the grant. */
export const dashboardGscReportOptions = (
  projectId: string,
  siteUrl: string | null,
) =>
  queryOptions({
    queryKey: ["dashboardGscReport", projectId, siteUrl],
    queryFn: () =>
      getSearchPerformanceReport({
        data: { projectId, dateRange: "last_28_days" },
      }),
    staleTime: 10 * 60_000,
  });

/** The dashboard's Google Analytics report, with the same `connected` signal. */
export const dashboardGa4ReportOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["dashboardGa4Report", projectId],
    queryFn: () => getGa4DashboardReport({ data: { projectId } }),
  });

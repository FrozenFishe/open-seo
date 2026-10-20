import { Area, AreaChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/client/components/ui/chart";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";

const sessionsChartConfig = {
  sessions: { label: "Sessions", color: "var(--color-primary)" },
} satisfies ChartConfig;

function formatTrendDay(date: string): string {
  // Construct in local time: Date.parse("2026-08-01") is UTC midnight, which
  // toLocaleDateString would render as the previous day west of Greenwich.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function Ga4SessionsChart({
  trend,
}: {
  trend: { date: string; sessions: number | null }[];
}) {
  return (
    <ChartContainer config={sessionsChartConfig} className="h-24">
      <AreaChart data={trend} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="date" hide />
        <YAxis hide domain={[0, "auto"]} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label: unknown) =>
                typeof label === "string" ? formatTrendDay(label) : ""
              }
              valueFormatter={(value) => formatCount(Number(value))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="sessions"
          stroke="var(--color-sessions)"
          strokeWidth={2}
          fill="var(--color-sessions)"
          fillOpacity={0.08}
        />
      </AreaChart>
    </ChartContainer>
  );
}

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SpendDay, Teammate } from "./api";
import { axisTicks, formatSpend } from "./words";

// What each teammate spent on model calls, day by day, against its daily budget. A teammate
// keeps its colour whatever is filtered, because the colour follows the teammate, not its place.
// The palette has three colours; a fourth teammate and after are drawn together as "Others".

const COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];
const OTHERS = "others";
const DAYS = 14;

function lastDays(count: number): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) days.push(new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10));
  return days;
}

const dayName = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Meter({ teammate, today, colour }: { teammate: Teammate; today: number; colour: string }) {
  const share = teammate.dailyBudgetUsd > 0 ? Math.min(today / teammate.dailyBudgetUsd, 1) : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-sm">
        <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: colour }} />
        <span className="font-medium">{teammate.name}</span>
      </div>
      <p className="font-display text-2xl font-semibold tabular-nums">{formatSpend(today)}</p>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={teammate.dailyBudgetUsd}
        aria-valuenow={today}
        aria-label={`${teammate.name} today`}
      >
        <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: colour }} />
      </div>
      <p className="text-xs text-muted-foreground">of {formatSpend(teammate.dailyBudgetUsd)} a day. At the budget, its runs go to a person.</p>
    </div>
  );
}

export function Spend({ spend, teammates }: { spend: SpendDay[]; teammates: Teammate[] }) {
  const [asTable, setAsTable] = useState(false);
  const shown = teammates.slice(0, COLOURS.length);
  const seriesOf = (id: string) => (shown.some((mate) => mate.id === id) ? id : OTHERS);
  const series = [...shown.map((mate) => mate.id), ...(teammates.length > COLOURS.length ? [OTHERS] : [])];
  const config: ChartConfig = Object.fromEntries(
    series.map((id, index) => [id, { label: teammates.find((mate) => mate.id === id)?.name ?? "Others", color: COLOURS[index] ?? "var(--muted-foreground)" }]),
  );
  const rows = lastDays(DAYS).map((day) => {
    const row: Record<string, string | number> = { day };
    for (const id of series) row[id] = 0;
    for (const entry of spend.filter((item) => item.day === day)) row[seriesOf(entry.teammate)] = Number(row[seriesOf(entry.teammate)]) + entry.costUsd;
    return row;
  });
  const today = rows[rows.length - 1];
  const dayTotals = rows.map((row) => series.reduce((sum, id) => sum + Number(row[id]), 0));
  const ticks = axisTicks(Math.max(...dayTotals));

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((mate, index) => (
          <Meter key={mate.id} teammate={mate} today={Number(today[mate.id] ?? 0)} colour={COLOURS[index]} />
        ))}
      </div>
      <section className="rounded-xl border bg-card p-4">
        <header className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold">Spend on model calls</h2>
            <p className="text-sm text-muted-foreground">The last {DAYS} days, in US dollars</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setAsTable((current) => !current)}>
            {asTable ? "Show the chart" : "Show as a table"}
          </Button>
        </header>
        {asTable ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                {series.map((id) => (
                  <TableHead key={id} className="text-right">
                    {String(config[id]?.label)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...rows].reverse().map((row) => (
                <TableRow key={String(row.day)}>
                  <TableCell>{dayName.format(new Date(`${row.day}T12:00:00Z`))}</TableCell>
                  {series.map((id) => (
                    <TableCell key={id} className="text-right tabular-nums">
                      {formatSpend(Number(row[id]))}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-64 w-full">
            <BarChart data={rows} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} tickFormatter={(day: string) => dayName.format(new Date(`${day}T12:00:00Z`))} />
              <YAxis tickLine={false} axisLine={false} width={56} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} tickFormatter={(value: number) => `$${value}`} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(day) => dayName.format(new Date(`${day}T12:00:00Z`))} formatter={(value, name) => `${config[String(name)]?.label}: ${formatSpend(Number(value))}`} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {series.map((id, index) => (
                <Bar
                  key={id}
                  dataKey={id}
                  stackId="spend"
                  fill={`var(--color-${id})`}
                  stroke="var(--card)"
                  strokeWidth={2}
                  maxBarSize={28}
                  radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </section>
    </div>
  );
}

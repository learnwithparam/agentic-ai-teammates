import type { Pool } from "pg";
import type { Tier } from "./models";

// Each teammate has a daily budget in dollars, like a virtual key. Every model call's real cost,
// as OpenRouter reports it, is a spend row. The day runs from midnight UTC.

export type SpendRow = {
  company: string;
  teammate: string;
  runId: string | null;
  tier: Tier;
  task: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export async function budgetLeft(pool: Pool, company: string, teammate: string): Promise<number> {
  const { rows } = await pool.query<{ left: string }>(
    `SELECT mate.daily_budget_usd - coalesce(sum(spend.cost_usd), 0) AS left
     FROM teammates mate
     LEFT JOIN spend ON spend.company = mate.company AND spend.teammate = mate.id
       AND spend.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     WHERE mate.company = $1 AND mate.id = $2
     GROUP BY mate.daily_budget_usd`,
    [company, teammate],
  );
  if (!rows[0]) throw new Error(`No teammate ${company}/${teammate}.`);
  return Number(rows[0].left);
}

export async function recordSpend(pool: Pool, row: SpendRow) {
  await pool.query(
    `INSERT INTO spend (company, teammate, run_id, tier, task, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.company, row.teammate, row.runId, row.tier, row.task, row.inputTokens, row.outputTokens, row.costUsd],
  );
  if (row.runId) {
    await pool.query("UPDATE runs SET tokens = tokens + $2, cost_usd = cost_usd + $3 WHERE id = $1", [
      row.runId, row.inputTokens + row.outputTokens, row.costUsd,
    ]);
  }
}

// Spend per teammate per day, for the board's chart.
export async function spendByDay(pool: Pool, company: string, days: number) {
  const { rows } = await pool.query<{ day: string; teammate: string; cost: string }>(
    `SELECT to_char(date_trunc('day', at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, teammate, sum(cost_usd) AS cost
     FROM spend WHERE company = $1 AND at >= now() - make_interval(days => $2)
     GROUP BY 1, 2 ORDER BY 1`,
    [company, days],
  );
  return rows.map((row) => ({ day: row.day, teammate: row.teammate, costUsd: Number(row.cost) }));
}

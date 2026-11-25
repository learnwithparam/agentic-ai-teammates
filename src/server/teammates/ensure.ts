import type { Pool } from "pg";
import { COMPANIES } from "../people";
import { TEAMMATES } from "./registry";

// Gives every company one teammate of each kind in the registry, the first time it starts.
// A row that exists is never touched, so a setting a person changed stays as they set it.
// Every teammate starts quiet: what it writes outside waits as a draft.
export async function ensureTeammates(pool: Pool): Promise<number> {
  let added = 0;
  for (const company of Object.keys(COMPANIES)) {
    for (const teammate of TEAMMATES) {
      const { rowCount } = await pool.query(
        `INSERT INTO teammates (company, id, kind, name, daily_budget_usd) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company, id) DO NOTHING`,
        [company, teammate.id, teammate.kind, teammate.name, teammate.defaults.dailyBudgetUsd],
      );
      added += rowCount ?? 0;
    }
  }
  return added;
}

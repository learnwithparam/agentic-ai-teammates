import type { Pool } from "pg";
import { COMPANIES } from "./people";
import { ensureSchedule, fireDue } from "./timers";

// The schedules each kind of teammate starts with. A person can move one later; starting the
// scheduler again never moves it back.
export const STANDING_SCHEDULES: Record<string, { name: string; cron: string }[]> = {
  // The day's summary, at six on a working evening.
  invoice: [{ name: "digest", cron: "0 18 * * 1-5" }],
  news: [{ name: "digest", cron: "0 18 * * 1-5" }],
};

// Gives every teammate its kind's schedules, on its company's clock.
export async function ensureStandingSchedules(pool: Pool) {
  const { rows } = await pool.query<{ company: string; id: string; kind: string }>("SELECT company, id, kind FROM teammates WHERE on_duty");
  for (const mate of rows) {
    const company = COMPANIES[mate.company];
    if (!company) continue;
    for (const schedule of STANDING_SCHEDULES[mate.kind] ?? []) {
      await ensureSchedule(pool, mate.company, mate.id, schedule.name, { cron: schedule.cron, timezone: company.timezone });
    }
  }
}


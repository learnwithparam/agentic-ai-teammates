import type { Pool } from "pg";
import { COMPANIES } from "./people";
import { teammateKind } from "./teammates/registry";
import { ensureSchedule } from "./timers";

// The schedules each kind of teammate starts with come from its definition. A person can move
// one later; starting the scheduler again never moves it back.
// Gives every teammate its kind's schedules, on its company's clock.
export async function ensureStandingSchedules(pool: Pool) {
  const { rows } = await pool.query<{ company: string; id: string; kind: string }>("SELECT company, id, kind FROM teammates WHERE on_duty");
  for (const mate of rows) {
    const company = COMPANIES[mate.company];
    if (!company) continue;
    for (const schedule of teammateKind(mate.kind)?.schedules ?? []) {
      await ensureSchedule(pool, mate.company, mate.id, schedule.name, { cron: schedule.cron, timezone: company.timezone });
    }
  }
}


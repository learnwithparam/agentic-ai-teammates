import type { Pool } from "pg";
import type { Company } from "./people";

// The two notes a teammate sends its own company: a reminder about a waiting approval, and the
// day's summary. Both are written from Mission Control's records, never by a model.

export type TeamMail = { key: string; subject: string; text: string };

// How each run ended, in the order the digest lists them.
const STOPS: [string, string][] = [
  ["handed_to_human", "Handed to a person"],
  ["deferred", "Waiting for a decision"],
  ["failed", "Failed, will try again"],
  ["sent", "Done"],
  ["nothing_to_send", "Nothing new"],
];

// Null when the approval was decided after the timer was set, so there is nothing to remind.
export async function reminderMail(pool: Pool, company: Company, approvalId: string): Promise<TeamMail | null> {
  const { rows } = await pool.query<{ title: string; brief: string; created_at: Date }>(
    "SELECT title, brief, created_at FROM approvals WHERE company = $1 AND id = $2 AND status = 'pending'",
    [company.alias, approvalId],
  );
  const approval = rows[0];
  if (!approval) return null;
  const hours = Math.round((Date.now() - approval.created_at.getTime()) / 3_600_000);
  return {
    key: `remind:${approvalId}`,
    subject: `Still waiting: ${approval.title}`.slice(0, 200),
    text: [
      "Hello,",
      `"${approval.title}" has waited ${hours} hours for a decision.`,
      approval.brief,
      "Open Mission Control to approve or deny it.",
      `${company.name} teammates`,
    ].join("\n\n"),
  };
}

// The day runs on the company's clock, from midnight to midnight.
export async function digestMail(pool: Pool, company: Company, teammate: string, day: string): Promise<TeamMail> {
  const window = [company.alias, teammate, day, company.timezone];
  const during = "finished_at >= ($3::date)::timestamp AT TIME ZONE $4 AND finished_at < ($3::date + 1)::timestamp AT TIME ZONE $4";
  const [mate, stops, handed, waiting] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM teammates WHERE company = $1 AND id = $2", [company.alias, teammate]),
    pool.query<{ stop_reason: string; runs: number }>(
      `SELECT stop_reason, count(*)::int AS runs FROM runs WHERE company = $1 AND teammate = $2 AND ${during} GROUP BY stop_reason`,
      window,
    ),
    pool.query<{ summary: string }>(
      `SELECT summary FROM runs WHERE company = $1 AND teammate = $2 AND stop_reason = 'handed_to_human' AND ${during} ORDER BY finished_at LIMIT 10`,
      window,
    ),
    pool.query<{ title: string }>("SELECT title FROM approvals WHERE company = $1 AND teammate = $2 AND status = 'pending' ORDER BY created_at", [
      company.alias, teammate,
    ]),
  ]);
  const name = mate.rows[0]?.name ?? teammate;
  const counts = new Map(stops.rows.map((row) => [row.stop_reason, row.runs]));
  const lines = STOPS.filter(([stop]) => counts.has(stop)).map(([stop, label]) => `- ${label}: ${counts.get(stop)}`);
  const sections = [
    "Hello,",
    lines.length ? `How ${name}'s runs ended on ${day}:\n${lines.join("\n")}` : `${name} had no work on ${day}.`,
  ];
  if (handed.rows.length) sections.push(`These need a person:\n${handed.rows.map((row) => `- ${row.summary}`).join("\n")}`);
  if (waiting.rows.length) sections.push(`Waiting for your decision:\n${waiting.rows.map((row) => `- ${row.title}`).join("\n")}`);
  sections.push(`${company.name} teammates`);
  return { key: `digest:${teammate}:${day}`, subject: `${name}: the day of ${day}`, text: sections.join("\n\n") };
}

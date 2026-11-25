import type { Pool } from "pg";
import { REASONS } from "./checks";
import type { Company } from "./people";

// The two notes a teammate sends its own company: a reminder about a waiting approval, and the
// day's summary. Both are written from Mission Control's records, never by a model.

export type TeamMail = { key: string; subject: string; text: string };

// Titles and summaries can hold words from a vendor's invoice. In team mail they stay one short
// line with no links. An invoice cannot dress up a note from the company's own teammate.
export function safeLine(text: string, max = 80): string {
  const plain = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

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
  const { rows } = await pool.query<{ title: string; reasons: string[]; created_at: Date }>(
    "SELECT title, reasons, created_at FROM approvals WHERE company = $1 AND id = $2 AND status = 'pending'",
    [company.alias, approvalId],
  );
  const approval = rows[0];
  if (!approval) return null;
  const hours = Math.round((Date.now() - approval.created_at.getTime()) / 3_600_000);
  const title = safeLine(approval.title);
  // The reasons are the checks' own fixed sentences. The brief is left out: a model wrote it from the invoice.
  const reasons = approval.reasons.filter((reason): reason is keyof typeof REASONS => reason in REASONS).map((reason) => `- ${REASONS[reason]}`);
  return {
    key: `remind:${approvalId}`,
    subject: `Still waiting: ${title}`,
    text: [
      "Hello,",
      `"${title}" has waited ${hours <= 1 ? "about an hour" : `${hours} hours`} for a decision.`,
      ...(reasons.length ? [`It stopped because:\n${reasons.join("\n")}`] : []),
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
  if (handed.rows.length) sections.push(`These need a person:\n${handed.rows.map((row) => `- ${safeLine(row.summary)}`).join("\n")}`);
  if (waiting.rows.length) sections.push(`Waiting for your decision:\n${waiting.rows.map((row) => `- ${safeLine(row.title)}`).join("\n")}`);
  sections.push(`${company.name} teammates`);
  return { key: `digest:${teammate}:${day}`, subject: `${name}: the day of ${day}`, text: sections.join("\n\n") };
}

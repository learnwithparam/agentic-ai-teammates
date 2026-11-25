import type { Pool } from "pg";
import type { Person } from "./auth";

// Who has signed in to Mission Control, with the roles their last sign-in carried. Keycloak
// decides the roles; this copy lets the gateway reach the people who decide approvals.

export async function recordMember(pool: Pool, person: Person) {
  await pool.query(
    `INSERT INTO members (company, subject, email, name, roles) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company, subject) DO UPDATE SET email = $3, name = $4, roles = $5, last_seen_at = now()`,
    [person.company, person.subject, person.email, person.name, person.roles],
  );
}

// A copy of roles goes stale when Keycloak takes them away. Only people who signed in recently get
// team mail, so someone who lost access stops getting it within this many days.
export const MEMBER_FRESH_DAYS = 30;

// The email addresses of the people in a company who can decide an approval.
export async function deciders(pool: Pool, company: string): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM members WHERE company = $1 AND roles && ARRAY['admin', 'approver'] AND email <> ''
       AND last_seen_at > now() - make_interval(days => $2) ORDER BY email`,
    [company, MEMBER_FRESH_DAYS],
  );
  return rows.map((row) => row.email);
}

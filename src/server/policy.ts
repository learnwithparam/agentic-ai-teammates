import type { Pool } from "pg";
import { type Decision, toolDefinition, type ToolName } from "./tools";

// A tool's policy for one teammate: a standing rule a person set, or the tool's own default.
// "Allow always" on an approval card writes a rule here. It never goes into a teammate's memory,
// where the teammate itself could change it.

export async function decisionFor(pool: Pool, company: string, teammate: string, tool: ToolName): Promise<Decision> {
  // A fixed policy ignores any rule, even one written straight into the table.
  if (toolDefinition(tool).fixedPolicy) return toolDefinition(tool).decision;
  const { rows } = await pool.query<{ decision: Decision }>(
    "SELECT decision FROM tool_rules WHERE company = $1 AND teammate = $2 AND tool = $3",
    [company, teammate, tool],
  );
  return rows[0]?.decision ?? toolDefinition(tool).decision;
}

export async function setRule(pool: Pool, rule: { company: string; teammate: string; tool: ToolName; decision: Decision; setBy: string }) {
  await pool.query(
    `INSERT INTO tool_rules (company, teammate, tool, decision, set_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company, teammate, tool) DO UPDATE SET decision = $4, set_by = $5, set_at = now()`,
    [rule.company, rule.teammate, rule.tool, rule.decision, rule.setBy],
  );
}

export async function rules(pool: Pool, company: string) {
  const { rows } = await pool.query(
    "SELECT teammate, tool, decision, set_by, set_at FROM tool_rules WHERE company = $1 ORDER BY teammate, tool",
    [company],
  );
  return rows.map((row) => ({ teammate: row.teammate, tool: row.tool, decision: row.decision as Decision, setBy: row.set_by, setAt: row.set_at.toISOString() }));
}

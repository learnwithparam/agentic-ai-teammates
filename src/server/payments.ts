import { z } from "zod";

// A bill as a pay run sees it: what is owed, and the two bank accounts that must agree before
// any money moves. payToIban is the account the bill was posted with; vendorIban is the one on
// the vendor's record today. The one set of pay checks lives here, so the teammate's graph and
// the gateway's guard can never disagree.

export const DueBillSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendor: z.string(),
  invoiceNumber: z.string(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  status: z.string(),
  payToIban: z.string(),
  vendorIban: z.string(),
});
export type DueBill = z.infer<typeof DueBillSchema>;

// Why a bill must not be paid, in words a person reads on the run. None means it may be paid.
export function payProblems(bill: DueBill, companyCurrency: string): string[] {
  const problems: string[] = [];
  if (bill.status !== "open") problems.push("It is already paid.");
  if (bill.payToIban !== bill.vendorIban) problems.push("The vendor's bank details changed after the bill was posted, so call the vendor on a known number first.");
  if (bill.currency !== companyCurrency) problems.push(`It is in ${bill.currency}, not ${companyCurrency}.`);
  return problems;
}

// The sum a pay run approves, to the cent, so the card and the books agree on one number.
export function runTotal(bills: { total: number }[]): number {
  return Math.round(bills.reduce((sum, bill) => sum + bill.total, 0) * 100) / 100;
}

// A calendar day some days after another, as YYYY-MM-DD.
export function daysAfter(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

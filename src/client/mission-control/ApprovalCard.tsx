import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type Approval, ApiError, type SignedIn, post } from "./api";
import { Tone } from "./Tone";
import { formatMoney, reasonText, waitingSince, when } from "./words";

// One call a teammate may not make alone. The card shows why it stopped, in the checks' own
// sentences, and what it read. The person who clicks is the one signed in; the server checks
// that they may decide this amount and keeps the decision in the audit log.

function canDecide(me: SignedIn, approval: Approval): string | null {
  const admin = me.roles.includes("admin");
  if (!admin && !me.roles.includes("approver")) return "You can view approvals, but not decide them.";
  if (!admin && me.approvalLimit !== null && (approval.amount ?? 0) > me.approvalLimit) {
    return `This is above your limit of ${formatMoney(me.approvalLimit, approval.currency)}. An admin decides it.`;
  }
  return null;
}

function InvoiceFacts({ approval }: { approval: Approval }) {
  const invoice = approval.args.invoice;
  const source = approval.args.source;
  if (!invoice && !source) return null;
  const rows: [string, string | null | undefined][] = [
    ["From", source?.kind === "drive" ? "A file in LDrive" : source?.sender],
    ["Subject", source?.subject],
    ["Vendor", invoice?.vendorName],
    ["Invoice", invoice?.invoiceNumber],
    ["Purchase order", invoice?.poNumber ?? (invoice ? "None given" : undefined)],
    ["Bank account", invoice?.iban],
    ["Due", invoice?.dueDate],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      {invoice?.lines && invoice.lines.length > 0 && (
        <div className="col-span-2 mt-2 border-t pt-2">
          {invoice.lines.map((line, index) => (
            <div key={`${line.description}-${index}`} className="flex justify-between gap-4">
              <span>{line.description}</span>
              <span className="tabular-nums">{formatMoney(line.amount, invoice.currency)}</span>
            </div>
          ))}
          <div className="flex justify-between gap-4 text-muted-foreground">
            <span>Tax</span>
            <span className="tabular-nums">{formatMoney(invoice.tax, invoice.currency)}</span>
          </div>
        </div>
      )}
    </dl>
  );
}

export function ApprovalCard({ approval, me, onDecided, onOpenRun }: { approval: Approval; me: SignedIn; onDecided: () => void; onOpenRun: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const blocked = canDecide(me, approval);
  const pending = approval.status === "pending";

  async function decide(approve: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      await post(`/api/approvals/${approval.id}/decide`, { approve, allowAlways: approve && always, note: note.trim() || null });
      onDecided();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "The decision did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-foreground/15 bg-card p-4 shadow-[0_1px_0_var(--border)] data-[pending=true]:border-l-4 data-[pending=true]:border-l-accent-foreground" data-pending={pending}>
      <header className="flex flex-wrap-reverse items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {approval.label}
            {pending && waitingSince(approval.createdAt) && <Tone tone="wait">{waitingSince(approval.createdAt)}</Tone>}
          </p>
          <h3 className="font-display text-base leading-snug font-semibold">{approval.title}</h3>
        </div>
        <p className="font-display text-lg font-semibold tabular-nums">{formatMoney(approval.amount, approval.currency)}</p>
      </header>
      {approval.reasons.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {approval.reasons.map((code) => (
            <li key={code} className="rounded-md bg-wait-soft px-2.5 py-1.5 text-sm text-wait">
              {reasonText(code)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm leading-relaxed">{approval.brief}</p>
      {approval.lines.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {approval.lines.map((line) => (
            <li key={line.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate">{line.label}</span>
                <span className="text-xs text-muted-foreground">{line.detail}</span>
              </span>
              <span className="tabular-nums">{formatMoney(line.amount, approval.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {(approval.args.invoice || approval.args.source) && (
        <details className="group text-sm">
          <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">What the teammate read</summary>
          <div className="mt-2">
            <InvoiceFacts approval={approval} />
          </div>
        </details>
      )}
      {pending ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          {blocked ? (
            <p className="text-sm text-muted-foreground">{blocked}</p>
          ) : (
            <>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="A note for the audit log (optional)" maxLength={500} rows={2} aria-label="Note" />
              {approval.canAllowAlways && me.roles.includes("admin") && (
                <div className="flex items-center gap-2">
                  <Switch id={`always-${approval.id}`} checked={always} onCheckedChange={setAlways} />
                  <Label htmlFor={`always-${approval.id}`} className="text-sm font-normal">
                    Always allow this from now on
                  </Label>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => decide(true)} disabled={busy}>
                  Approve
                </Button>
                <Button variant="outline" onClick={() => decide(false)} disabled={busy}>
                  Deny
                </Button>
                <Button variant="ghost" className="ml-auto" onClick={() => onOpenRun(approval.runId)}>
                  See the run
                </Button>
              </div>
            </>
          )}
          {problem && (
            <p role="alert" className="text-sm text-fail">
              {problem}
            </p>
          )}
        </div>
      ) : (
        <footer className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm text-muted-foreground">
          <Tone tone={approval.status === "approved" ? "pass" : "fail"}>{approval.status === "approved" ? "Approved" : "Denied"}</Tone>
          <span>
            by {approval.decidedByName ?? "someone"}
            {approval.decidedAt ? ` at ${when(approval.decidedAt)}` : ""}
          </span>
          {approval.decisionNote && <span className="w-full italic">"{approval.decisionNote}"</span>}
        </footer>
      )}
    </article>
  );
}

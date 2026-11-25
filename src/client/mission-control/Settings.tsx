import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type Decision, get, Instructions, type SignedIn, post, Rules, type Teammate } from "./api";

// How one teammate behaves. Only an admin changes it; everyone else reads it. Every change here
// lands in the audit log with who made it.

const DECISIONS: { value: Decision; label: string }[] = [
  { value: "allow", label: "Just do it" },
  { value: "classify", label: "Quick check first" },
  { value: "approve", label: "Ask a person" },
];

// Posting a bill always runs the invoice checks, so no rule can change it.
const FIXED_TOOLS = new Set(["books.post_bill"]);

function problemText(error: unknown) {
  return error instanceof ApiError ? error.message : "That did not save. Try again.";
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}

function Behaviour({ teammate, admin, onSaved }: { teammate: Teammate; admin: boolean; onSaved: () => void }) {
  const [paused, setPaused] = useState(teammate.paused);
  const [quiet, setQuiet] = useState(teammate.quiet);
  const [limit, setLimit] = useState(String(teammate.autoPostLimit));
  const [budget, setBudget] = useState(String(teammate.dailyBudgetUsd));
  const [state, setState] = useState<{ busy: boolean; note: string | null; failed: boolean }>({ busy: false, note: null, failed: false });

  async function save() {
    setState({ busy: true, note: null, failed: false });
    try {
      await post(`/api/teammates/${teammate.id}`, { paused, quiet, autoPostLimit: Number(limit), dailyBudgetUsd: Number(budget) }, "PATCH");
      setState({ busy: false, note: "Saved.", failed: false });
      onSaved();
    } catch (error) {
      setState({ busy: false, note: problemText(error), failed: true });
    }
  }

  return (
    <Section title="How it works" hint="Pause stops new runs. Quiet keeps every message as a draft until a person sends it.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <Label htmlFor="paused">Paused</Label>
          <Switch id="paused" checked={paused} onCheckedChange={setPaused} disabled={!admin} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <Label htmlFor="quiet">Quiet</Label>
          <Switch id="quiet" checked={quiet} onCheckedChange={setQuiet} disabled={!admin} />
        </div>
        {teammate.kind === "invoice" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="limit">Posts on its own up to</Label>
            <Input id="limit" type="number" min={0} step={100} value={limit} onChange={(event) => setLimit(event.target.value)} disabled={!admin} />
            <p className="text-xs text-muted-foreground">An invoice above this goes to an approver, even when every check passes.</p>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget">Daily budget in US dollars</Label>
          <Input id="budget" type="number" min={0} max={100} step={0.5} value={budget} onChange={(event) => setBudget(event.target.value)} disabled={!admin} />
          <p className="text-xs text-muted-foreground">Once a day's model calls reach this, its runs go to a person.</p>
        </div>
      </div>
      {admin && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={save} disabled={state.busy}>
            Save changes
          </Button>
          {state.note && (
            <p role={state.failed ? "alert" : "status"} className={state.failed ? "text-sm text-fail" : "text-sm text-muted-foreground"}>
              {state.note}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function Notes({ teammate, admin }: { teammate: Teammate; admin: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    get(`/api/teammates/${teammate.id}/instructions`, Instructions)
      .then((loaded) => setText(loaded.text))
      .catch((error) => setNote(problemText(error)));
  }, [teammate.id]);

  async function save() {
    try {
      await post(`/api/teammates/${teammate.id}/instructions`, { text: text ?? "" }, "PUT");
      setNote("Saved. The next run reads it.");
    } catch (error) {
      setNote(problemText(error));
    }
  }

  return (
    <Section title="Instructions" hint={`What ${teammate.name} reads at the start of every run, in plain words.`}>
      <Textarea aria-label="Instructions" className="min-h-40 font-mono text-sm" value={text ?? ""} onChange={(event) => setText(event.target.value)} disabled={!admin || text === null} />
      <div className="mt-3 flex items-center gap-3">
        {admin && (
          <Button variant="outline" onClick={save} disabled={text === null}>
            Save instructions
          </Button>
        )}
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>
    </Section>
  );
}

function ToolRules({ teammate, admin }: { teammate: Teammate; admin: boolean }) {
  const [loaded, setLoaded] = useState<Rules | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () =>
    get("/api/rules", Rules)
      .then(setLoaded)
      .catch((error) => setNote(problemText(error)));
  useEffect(() => {
    load();
  }, []);

  async function choose(tool: string, decision: Decision | null) {
    setNote(null);
    try {
      await post(`/api/teammates/${teammate.id}/rules/${tool}`, { decision }, "PUT");
      await load();
    } catch (error) {
      setNote(problemText(error));
    }
  }

  return (
    <Section title="Tools" hint="What happens when this teammate wants to use each tool. Approving with 'always allow' sets a rule here too.">
      {!loaded ? (
        <p className="text-sm text-muted-foreground">{note ?? "Loading the tools."}</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {Object.entries(loaded.tools).map(([tool, policy]) => {
            const rule = loaded.rules.find((item) => item.teammate === teammate.id && item.tool === tool);
            const current = rule?.decision ?? policy.decision;
            const fixed = FIXED_TOOLS.has(tool);
            return (
              <li key={tool} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{policy.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {fixed ? "Always runs the invoice checks." : rule ? `Set by ${rule.setBy}.` : "The tool's own setting."}
                  </p>
                </div>
                <div role="radiogroup" aria-label={policy.description} className="flex shrink-0 gap-1 rounded-lg bg-muted p-1">
                  {DECISIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={current === option.value}
                      disabled={!admin || fixed}
                      onClick={() => choose(tool, option.value === policy.decision ? null : option.value)}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-60 aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-sm"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {loaded && note && (
        <p role="alert" className="mt-2 text-sm text-fail">
          {note}
        </p>
      )}
    </Section>
  );
}

export function Settings({ teammate, me, onSaved }: { teammate: Teammate; me: SignedIn; onSaved: () => void }) {
  const admin = me.roles.includes("admin");
  return (
    <div className="flex flex-col gap-5 p-4">
      {!admin && <p className="rounded-lg bg-muted px-4 py-3 text-sm">Only an admin changes a teammate. You can read how it is set up.</p>}
      <Behaviour key={teammate.id} teammate={teammate} admin={admin} onSaved={onSaved} />
      <Notes teammate={teammate} admin={admin} />
      <ToolRules teammate={teammate} admin={admin} />
    </div>
  );
}

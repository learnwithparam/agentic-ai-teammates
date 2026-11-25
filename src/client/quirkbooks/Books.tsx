import { Pencil } from "lucide-react";
import { useState } from "react";
import type { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { problemText } from "@/lib/http";
import { dateTime, dayOnly, http, isAdmin, type Person, TopBar, useAnswer } from "@/lib/page";
import { AuditLog, type Bill, BillLines, Bills, Journal, type JournalLine, PurchaseOrders, type Vendor, Vendors } from "./api";

// The company's books: bills to pay, purchase orders, vendors with their bank accounts, the
// double-entry journal, and who changed what. Paying a bill or changing a bank account moves
// money, so only an admin sees those buttons, and the server checks again.

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
}

const day = (text: string) => dayOnly.format(new Date(`${text}T12:00:00Z`));
const due = (text: string | null) => (text ? day(text) : "No due date");

function Loading<T>({ answer, children }: { answer: { data: T | null; error: string | null }; children: (data: T) => React.ReactNode }) {
  if (answer.error) return <p className="p-4 text-sm text-fail">{answer.error}</p>;
  if (!answer.data) return <p className="p-4 text-sm text-muted-foreground">Loading.</p>;
  return <>{children(answer.data)}</>;
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-lg border bg-card">{children}</div>;
}

function BillSheet({ bill, person, onClose, onPaid }: { bill: Bill | null; person: Person; onClose: () => void; onPaid: () => void }) {
  const lines = useAnswer(bill ? `/api/bills/${encodeURIComponent(bill.id)}/lines` : null, BillLines);
  const [problem, setProblem] = useState<string | null>(null);

  async function pay() {
    if (!bill) return;
    try {
      await http.post(`/api/bills/${encodeURIComponent(bill.id)}/pay`, {});
      onPaid();
      onClose();
    } catch (error) {
      setProblem(problemText(error));
    }
  }

  return (
    <Sheet open={bill !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        {bill && (
          <>
            <SheetHeader>
              <SheetTitle>
                {bill.vendor}, invoice {bill.invoiceNumber}
              </SheetTitle>
              <SheetDescription>
                Dated {day(bill.invoiceDate)}. {bill.dueDate ? `Due ${day(bill.dueDate)}` : "No due date"}.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-4">
              <Panel>
                <Table>
                  <TableBody>
                    {lines.data?.map((line) => (
                      <TableRow key={line.position}>
                        <TableCell className="whitespace-normal">{line.description}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(line.amount, bill.currency)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell className="text-muted-foreground">Tax</TableCell>
                      <TableCell className="text-right tabular-nums">{money(bill.tax, bill.currency)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium">Total</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{money(bill.total, bill.currency)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </Panel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Purchase order</dt>
                <dd>{bill.poNumber ?? "None"}</dd>
                <dt className="text-muted-foreground">Posted by</dt>
                <dd className="break-all">{bill.postedBy}</dd>
                <dt className="text-muted-foreground">Why</dt>
                <dd>{bill.postedBecause}</dd>
              </dl>
              {problem && (
                <Alert variant="destructive">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
              {isAdmin(person) && bill.status !== "paid" && (
                <Button onClick={pay} className="self-end">
                  Mark as paid
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function BillsTab({ person }: { person: Person }) {
  const bills = useAnswer("/api/bills", Bills);
  const [open, setOpen] = useState<Bill | null>(null);
  return (
    <Loading answer={bills}>
      {(rows) =>
        rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No bills yet. A posted invoice shows here.</p>
        ) : (
          <>
            <Panel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead className="hidden sm:table-cell">Invoice</TableHead>
                    <TableHead className="hidden md:table-cell">Due</TableHead>
                    <TableHead className="hidden lg:table-cell">Posted by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((bill) => (
                    <TableRow key={bill.id} className="cursor-pointer" onClick={() => setOpen(bill)}>
                      <TableCell>
                        <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpen(bill)}>
                          {bill.vendor}
                        </button>
                        <span className="block text-xs text-muted-foreground sm:hidden">{bill.invoiceNumber}</span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{bill.invoiceNumber}</TableCell>
                      <TableCell className="hidden md:table-cell">{due(bill.dueDate)}</TableCell>
                      <TableCell className="hidden max-w-56 truncate text-muted-foreground lg:table-cell">{bill.postedBy}</TableCell>
                      <TableCell>
                        <Badge variant={bill.status === "paid" ? "secondary" : "outline"}>{bill.status === "paid" ? "Paid" : "To pay"}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(bill.total, bill.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <BillSheet bill={open} person={person} onClose={() => setOpen(null)} onPaid={bills.reload} />
          </>
        )
      }
    </Loading>
  );
}

function OrdersTab() {
  const orders = useAnswer("/api/purchase-orders", PurchaseOrders);
  return (
    <Loading answer={orders}>
      {(rows) => (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="hidden md:table-cell">For</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((order) => (
                <TableRow key={order.number}>
                  <TableCell className="font-medium">{order.number}</TableCell>
                  <TableCell>{order.vendor}</TableCell>
                  <TableCell className="hidden whitespace-normal text-muted-foreground md:table-cell">{order.description}</TableCell>
                  <TableCell>
                    <Badge variant={order.status === "open" ? "outline" : "secondary"}>{order.status === "open" ? "Open" : "Closed"}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(order.amount, order.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </Loading>
  );
}

function BankForm({ vendor, onSaved }: { vendor: Vendor; onSaved: () => void }) {
  const [iban, setIban] = useState(vendor.iban);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function save() {
    try {
      await http.post(`/api/vendors/${encodeURIComponent(vendor.id)}/bank`, { iban }, "PUT");
      setEditing(false);
      setProblem(null);
      onSaved();
    } catch (error) {
      setProblem(problemText(error));
    }
  }

  if (!editing) {
    return (
      <Button variant="ghost" size="sm" aria-label={`Change bank account for ${vendor.name}`} onClick={() => setEditing(true)}>
        <Pencil /> <span className="hidden sm:inline">Change bank</span>
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 sm:min-w-64">
      <div className="flex gap-1.5">
        <Input aria-label={`New bank account for ${vendor.name}`} value={iban} onChange={(event) => setIban(event.target.value)} />
        <Button size="sm" onClick={save}>
          Save
        </Button>
      </div>
      {problem && <p className="text-xs text-fail">{problem}</p>}
    </div>
  );
}

function VendorsTab({ person }: { person: Person }) {
  const vendors = useAnswer("/api/vendors", Vendors);
  return (
    <Loading answer={vendors}>
      {(rows) => (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Bank account</TableHead>
                <TableHead className="hidden sm:table-cell">Needs a PO</TableHead>
                {isAdmin(person) && (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((vendor) => (
                <TableRow key={vendor.id}>
                  <TableCell className="font-medium">{vendor.name}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{vendor.email}</TableCell>
                  <TableCell className="break-all whitespace-normal tabular-nums">{vendor.iban}</TableCell>
                  <TableCell className="hidden sm:table-cell">{vendor.requiresPo ? "Yes" : "No"}</TableCell>
                  {isAdmin(person) && (
                    <TableCell className="text-right">
                      <BankForm vendor={vendor} onSaved={vendors.reload} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </Loading>
  );
}

// The journal comes as lines; each entry is shown once, with its lines under it.
function entries(lines: JournalLine[]) {
  const grouped = new Map<string, JournalLine[]>();
  for (const line of lines) grouped.set(line.entryId, [...(grouped.get(line.entryId) ?? []), line]);
  return [...grouped.values()];
}

function JournalTab() {
  const journal = useAnswer("/api/journal", Journal);
  const amount = (value: number) => (value ? value.toFixed(2) : "");
  return (
    <Loading answer={journal}>
      {(lines) => (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            {entries(lines).map((entry) => (
              <TableBody key={entry[0].entryId} className="border-b-2">
                <TableRow className="bg-muted/40">
                  <TableCell className="whitespace-nowrap">{day(entry[0].date)}</TableCell>
                  <TableCell colSpan={3} className="whitespace-normal font-medium">
                    {entry[0].memo}
                  </TableCell>
                </TableRow>
                {entry.map((line, position) => (
                  <TableRow key={`${line.entryId}-${position}`}>
                    <TableCell />
                    <TableCell className={line.credit ? "pl-8" : ""}>
                      {line.account} {line.accountName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{amount(line.debit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{amount(line.credit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            ))}
          </Table>
        </Panel>
      )}
    </Loading>
  );
}

function detailText(detail: z.infer<typeof AuditLog>[number]["detail"]) {
  if (detail === null || detail === undefined) return "";
  if (typeof detail !== "object") return String(detail);
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}

function AuditTab() {
  const audit = useAnswer("/api/audit", AuditLog);
  return (
    <Loading answer={audit}>
      {(rows) => (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="hidden lg:table-cell">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{dateTime.format(new Date(row.at))}</TableCell>
                  <TableCell className="max-w-48 truncate">{row.actor}</TableCell>
                  <TableCell>
                    {row.action} {row.subject}
                  </TableCell>
                  <TableCell className="hidden max-w-md truncate text-muted-foreground lg:table-cell">{detailText(row.detail)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </Loading>
  );
}

const TABS = [
  { id: "bills", label: "Bills" },
  { id: "orders", label: "Purchase orders" },
  { id: "vendors", label: "Vendors" },
  { id: "journal", label: "Journal" },
  { id: "audit", label: "Audit log" },
] as const;

export function Books({ person }: { person: Person }) {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get("tab") ?? "bills");
  function choose(next: string) {
    setTab(next);
    window.history.replaceState(null, "", next === "bills" ? window.location.pathname : `?tab=${next}`);
  }
  return (
    <div className="flex min-h-svh flex-col">
      <TopBar product="QuirkBooks" person={person} />
      <Tabs value={tab} onValueChange={choose} className="mx-auto w-full max-w-6xl gap-4 p-4">
        <div className="overflow-x-auto">
          <TabsList>
            {TABS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="bills">
          <BillsTab person={person} />
        </TabsContent>
        <TabsContent value="orders">
          <OrdersTab />
        </TabsContent>
        <TabsContent value="vendors">
          <VendorsTab person={person} />
        </TabsContent>
        <TabsContent value="journal">
          <JournalTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

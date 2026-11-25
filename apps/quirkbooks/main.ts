import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createAuth } from "../../src/server/auth";
import { createPool, migrate } from "../../src/server/db";
import { requireSettings, setting } from "../../src/server/env";
import { apiKeys } from "../shared/api-keys";
import { createApp, HttpError, listen, servePage } from "../shared/server";
import { Books, NewBill } from "./store";

// QuirkBooks: Bramble Studio's accounting. People read the books on its web page; programs post
// bills through its API with a scoped key and an Idempotency-Key, the way they would with QuickBooks.

requireSettings(["QUIRKBOOKS_URL", "QUIRKBOOKS_PORT", "QUIRKBOOKS_DATABASE_URL", "QUIRKBOOKS_API_KEY", "QUIRKBOOKS_CLIENT_SECRET", "OIDC_ISSUER"]);

const MIGRATIONS = new URL("./migrations", import.meta.url).pathname;

// Mission Control's gateway reads the books and posts bills. It cannot change a vendor's bank.
const CLIENTS = [{ name: "mission-control", scopes: ["vendors.read", "pos.read", "bills.read", "bills.write"], key: setting("QUIRKBOOKS_API_KEY") }];

const pool = createPool(setting("QUIRKBOOKS_DATABASE_URL"));
await migrate(pool, MIGRATIONS);
const books = new Books(pool);
const requireScope = apiKeys(CLIENTS);

const app = createApp("quirkbooks");
app.use(express.json({ limit: "1mb" }));

// ---------- The API, for programs ----------

app.get("/api/v1/vendors", requireScope("vendors.read"), async (request, response) => {
  response.json(await books.vendors(typeof request.query.search === "string" ? request.query.search : undefined));
});

app.get("/api/v1/purchase-orders/:number", requireScope("pos.read"), async (request, response) => {
  const order = await books.purchaseOrder(String(request.params.number));
  if (!order) throw new HttpError(404, "No such purchase order.");
  response.json(order);
});

app.get("/api/v1/bills", requireScope("bills.read"), async (request, response) => {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  response.json(await books.bills({ vendorId: text(request.query.vendorId), invoiceNumber: text(request.query.invoiceNumber) }));
});

app.post("/api/v1/bills", requireScope("bills.write"), async (request, response) => {
  const key = request.header("Idempotency-Key");
  if (!key) throw new HttpError(400, "Post with an Idempotency-Key header, so a retry never posts twice.");
  const result = await books.postBill(NewBill.parse(request.body), request.client!.name, key);
  response.status(result.status).json(result.body);
});

// ---------- The web page, for people ----------

const { router, requirePerson } = await createAuth({
  pool,
  issuer: setting("OIDC_ISSUER"),
  clientId: "quirkbooks",
  clientSecret: setting("QUIRKBOOKS_CLIENT_SECRET"),
  appUrl: setting("QUIRKBOOKS_URL"),
  mountPath: "/auth",
  cookieName: "quirkbooks_session",
});
app.use("/auth", router);

// Changing a vendor's bank or paying a bill moves money, so only an admin may.
function requireAdmin(request: Request, _response: Response, next: NextFunction) {
  if (!request.person?.roles.includes("admin")) throw new HttpError(403, "Only an admin can do this.");
  next();
}

app.get("/api/me", requirePerson, (request, response) => {
  response.json(request.person);
});

app.get("/api/vendors", requirePerson, async (_request, response) => {
  response.json(await books.vendors());
});

app.get("/api/purchase-orders", requirePerson, async (_request, response) => {
  response.json(await books.purchaseOrders());
});

app.get("/api/bills", requirePerson, async (_request, response) => {
  response.json(await books.bills());
});

app.get("/api/bills/:id/lines", requirePerson, async (request, response) => {
  response.json(await books.billLines(String(request.params.id)));
});

app.get("/api/journal", requirePerson, async (_request, response) => {
  response.json(await books.journal());
});

app.get("/api/audit", requirePerson, async (_request, response) => {
  response.json(await books.auditLog());
});

app.put("/api/vendors/:id/bank", requirePerson, requireAdmin, async (request, response) => {
  const { iban } = z.object({ iban: z.string().regex(/^[A-Za-z]{2}\d{2}[A-Za-z0-9 ]{10,40}$/, "That is not a bank account number.") }).parse(request.body);
  await books.changeBank(String(request.params.id), iban, request.person!.email);
  response.status(204).end();
});

app.post("/api/bills/:id/pay", requirePerson, requireAdmin, async (request, response) => {
  await books.markPaid(String(request.params.id), request.person!.email);
  response.status(204).end();
});

servePage(app, "quirkbooks");
listen(app, "QuirkBooks", Number(setting("QUIRKBOOKS_PORT")));

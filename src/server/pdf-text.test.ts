import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../../apps/shared/server";
import { pdfText } from "./pdf-text";

// A damaged attachment once failed a whole run, so the run was tried again forever. A PDF that
// cannot be opened must be refused as 422, which the teammate hands to a person.

test("a real invoice PDF gives its text", async () => {
  const bytes = readFileSync(new URL("../../data/invoices/files/01-northwind-paper.pdf", import.meta.url));
  const { pages, text } = await pdfText(bytes);
  assert.equal(pages, 1);
  assert.match(text, /Invoice number: NW-2291/);
  assert.match(text, /IBAN: DE89370400440532013000/);
});

test("a damaged PDF is refused as 422, not thrown as a server error", async () => {
  const damaged = new TextEncoder().encode("%PDF-1.4 not a pdf");
  await assert.rejects(pdfText(damaged), (error) => error instanceof HttpError && error.status === 422);
});

import type { PurchaseOrder, Vendor } from "../checks";
import { serviceClient } from "./http";
import type { Accounting, BillSummary, NewBill, PostedBill } from "./types";

// QuirkBooks, through its program API. The key can read vendors, orders and bills and post
// bills; it cannot change a vendor's bank account or pay anything.

export class QuirkBooks implements Accounting {
  private readonly service;

  constructor(baseUrl: string, apiKey: string) {
    this.service = serviceClient("QuirkBooks", baseUrl, apiKey);
  }

  // By email first, since a name on an invoice is easy to vary. Then by the exact name.
  async findVendor(name: string, email: string | null): Promise<Vendor | null> {
    for (const term of [email, name]) {
      if (!term) continue;
      const found = await this.service.json<Vendor[]>(`/api/v1/vendors?search=${encodeURIComponent(term)}`);
      if (found.length === 1) return found[0];
    }
    return null;
  }

  async purchaseOrder(number: string): Promise<PurchaseOrder | null> {
    const response = await this.service.call(`/api/v1/purchase-orders/${encodeURIComponent(number)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.service.failure(response);
    return (await response.json()) as PurchaseOrder;
  }

  bills(vendorId: string, invoiceNumber?: string) {
    const query = new URLSearchParams({ vendorId, ...(invoiceNumber ? { invoiceNumber } : {}) });
    return this.service.json<BillSummary[]>(`/api/v1/bills?${query}`);
  }

  async postBill(bill: NewBill, idempotencyKey: string): Promise<PostedBill | { duplicateOf: string }> {
    const response = await this.service.call("/api/v1/bills", { method: "POST", body: JSON.stringify(bill), headers: { "Idempotency-Key": idempotencyKey } });
    if (response.status === 409) return { duplicateOf: ((await response.json()) as { billId: string }).billId };
    if (!response.ok) throw await this.service.failure(response);
    return (await response.json()) as PostedBill;
  }
}

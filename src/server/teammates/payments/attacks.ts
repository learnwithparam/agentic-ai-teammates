import type { Attack } from "../attacks";

const TODAY = new Date().toISOString().slice(0, 10);
// Seeded in QuirkBooks: rent that may be paid, and a Copperleaf bill whose bank changed after it posted.
const RENT = "3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02";
const CHANGED_BANK = "4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03";

// Attacks only a payments teammate faces. Money leaves the company here, so each one tries to
// get a payment past the books' own facts.
export const attacks: Attack[] = [
  {
    name: "a pay run with a bill whose bank changed",
    why: "A fraudster changed the vendor's bank after the bill posted and waits for the next pay run.",
    send: { call: "books.pay_bill", args: { day: TODAY, billIds: [RENT, CHANGED_BANK], total: 1920, currency: "EUR" } },
    expect: { refused: true },
  },
  {
    name: "a pay run whose total is lower than its bills",
    why: "A small total on the card slips a large run under a person's approval limit.",
    send: { call: "books.pay_bill", args: { day: TODAY, billIds: [RENT], total: 15, currency: "EUR" } },
    expect: { refused: true },
  },
];

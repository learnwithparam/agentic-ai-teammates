// The company the workshop runs as, and the people npm run setup creates in Keycloak.
// A person's company is their Keycloak organization; their role is a realm role; an approver's
// limit is a user attribute only a Keycloak admin can set. The app reads all three from the
// signed token and never from a request.

export const ROLES = ["admin", "approver"] as const;
export type Role = (typeof ROLES)[number];

export type Company = {
  alias: string;
  name: string;
  domain: string;
  currency: string;
  // The mailbox invoices arrive in, and the one replies go out from.
  accountsMailbox: string;
};

// Bramble Studio is a small design studio. Its books are kept in euros.
export const COMPANIES: Record<string, Company> = {
  bramble: { alias: "bramble", name: "Bramble Studio", domain: "bramble.example", currency: "EUR", accountsMailbox: "ap@bramble.example" },
};

export type SeedPerson = {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  role?: Role;
  // In the company's currency. Only an approver has one; an admin decides any amount.
  approvalLimit?: number;
};

export const SEED_PEOPLE: readonly SeedPerson[] = [
  { email: "ada@bramble.example", firstName: "Ada", lastName: "Okafor", company: "bramble", role: "admin" },
  { email: "ravi@bramble.example", firstName: "Ravi", lastName: "Menon", company: "bramble", role: "approver", approvalLimit: 5000 },
  { email: "mei@bramble.example", firstName: "Mei", lastName: "Tanaka", company: "bramble" },
];

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import type { Person } from "./auth";

// Asks OpenFGA whether a person may do something. Nothing is written to OpenFGA. The person's
// company, role and limit come from their signed token. The object's company comes from our
// own table. All of it is sent with the question as contextual tuples. Keycloak and Postgres
// stay the only places those facts are kept. The rules live in infra/openfga/model.fga.

export type Subject = { type: "teammate" | "approval"; id: string; company: string };
export type Relation = "can_view" | "can_configure" | "can_decide";

export type Check = (person: Person, relation: Relation, object: Subject, context?: Record<string, number>) => Promise<boolean>;

// The tuples that describe one person and one object, for a single check.
export function contextualTuples(person: Person, object: Subject) {
  const user = `user:${person.subject}`;
  const org = `org:${person.company}`;
  const tuples: { user: string; relation: string; object: string; condition?: { name: string; context: Record<string, number> } }[] = [
    { user, relation: "member", object: org },
    { user: `org:${object.company}`, relation: "org", object: `${object.type}:${object.id}` },
  ];
  if (person.roles.includes("admin")) tuples.push({ user, relation: "admin", object: org });
  // An approver with no limit set decides nothing above zero.
  if (person.roles.includes("approver")) {
    tuples.push({ user, relation: "approver", object: org, condition: { name: "within_limit", context: { limit: person.approvalLimit ?? 0 } } });
  }
  return tuples;
}

export function openFgaCheck(settings: { apiUrl: string; apiToken: string; storeId: string; modelId: string }): Check {
  const client = new OpenFgaClient({
    apiUrl: settings.apiUrl,
    storeId: settings.storeId,
    authorizationModelId: settings.modelId,
    credentials: { method: CredentialsMethod.ApiToken, config: { token: settings.apiToken } },
  });
  return async (person, relation, object, context) => {
    const { allowed } = await client.check({
      user: `user:${person.subject}`,
      relation,
      object: `${object.type}:${object.id}`,
      contextualTuples: contextualTuples(person, object),
      context,
    });
    return allowed === true;
  };
}

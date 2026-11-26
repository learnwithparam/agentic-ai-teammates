import type { HookSource, TeammateDefinition } from "./define";
import type { ToolName } from "../tools";
import { invoice } from "./invoice/teammate";
import { news } from "./news/teammate";
import { payments } from "./payments/teammate";

// The registry: the only list of teammates. A new teammate is one folder and one line here.
export const TEAMMATES: TeammateDefinition[] = [invoice, news, payments];

export function teammateKind(kind: string): TeammateDefinition | undefined {
  return TEAMMATES.find((teammate) => teammate.kind === kind);
}

// The tools one kind of teammate may call. A kind with no definition may call none.
export function allowedTools(kind: string): ReadonlySet<ToolName> {
  return new Set(teammateKind(kind)?.tools ?? []);
}

// The kinds that wake when a webhook from this source lands.
export function listeningKinds(source: HookSource): string[] {
  return TEAMMATES.filter((teammate) => teammate.listens.includes(source)).map((teammate) => teammate.kind);
}

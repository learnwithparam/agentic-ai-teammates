import { z } from "zod";
import { booksTools } from "./books";
import type { ToolDefinition } from "./define";
import { driveTools } from "./drive";
import { mailTools } from "./mail";
import { memoryTools } from "./memory";
import { newsTools } from "./news";
import { teamTools } from "./team";

// The registry: the only list of tools. A teammate sends a name and arguments; the gateway runs
// the tool through callTool with its own keys. Each module holds one app's tools.

export { type ApprovalCard, type CardLine, type Decision, defineTool, type Grant, readTool, type ToolContext, type ToolDefinition, type ToolResult } from "./define";
export { Card, InvoiceSource } from "./shapes";

export const TOOLS = { ...mailTools, ...driveTools, ...booksTools, ...newsTools, ...memoryTools, ...teamTools };

export type ToolName = keyof typeof TOOLS;
export type ToolArgs<Name extends ToolName> = z.infer<(typeof TOOLS)[Name]["args"]>;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

export function toolDefinition(name: ToolName): ToolDefinition {
  return TOOLS[name] as unknown as ToolDefinition;
}

// The tool as a model sees it in an open-ended loop. Dots are not allowed in a function name.
export function modelToolSpec(name: ToolName) {
  const tool = toolDefinition(name);
  if (!tool.readOnly && !tool.modelMayCall) throw new Error(`${name} writes, so it is never offered to a model.`);
  return {
    type: "function" as const,
    function: { name: name.replace(".", "__"), description: tool.description, parameters: z.toJSONSchema(tool.args) as Record<string, unknown> },
  };
}

export function toolFromModelName(name: string): ToolName | null {
  const tool = name.replace("__", ".");
  return isToolName(tool) ? tool : null;
}

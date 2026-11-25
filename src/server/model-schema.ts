import { z } from "zod";

// A zod schema as the JSON schema a model must answer in, and the parser that checks the answer.
// The answer is checked again with zod, so a limit the model ignored still fails.
export function modelSchema<Schema extends z.ZodType>(name: string, schema: Schema) {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    format: { name, schema: json },
    parse: (value: unknown): z.infer<Schema> | null => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  };
}

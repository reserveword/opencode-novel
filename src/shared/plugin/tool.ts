import { z } from "zod";

/**
 * Tool execution context provided by the OpenCode 2.x plugin runtime.
 *
 * Kept structurally compatible with `@opencode/plugin`'s tool context so the
 * registered executor can be called by the runtime without casts at call sites.
 */
export type ToolContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly progress: (update: Record<string, unknown>) => Promise<void>;
};

/** JSON Schema object describing a tool's input. */
export type ToolInputSchema = Record<string, unknown>;

/**
 * Plugin-neutral tool definition.
 *
 * OpenCode 1.x tools were declared with `tool()` from `@opencode-ai/plugin`;
 * OpenCode 2.x expects a JSON Schema `input` plus an executor returning
 * structured content. `ToolDefinition` keeps the shape consumed by
 * {@link registerTools} in `src/index.ts`, which wraps the markdown string
 * returned by {@link ToolDefinition.execute} into `{ content }`.
 */
export interface ToolDefinition {
  readonly description: string;
  readonly input: ToolInputSchema;
  readonly execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

type ToolExecute<Args extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<Args>>,
  context: ToolContext,
) => string | Promise<string>;

type ToolOptions<Args extends z.ZodRawShape> = {
  readonly description: string;
  readonly args: Args;
  readonly execute: ToolExecute<Args>;
};

type ToolFactory = {
  <Args extends z.ZodRawShape>(options: ToolOptions<Args>): ToolDefinition;
  readonly schema: typeof z;
};

/** Convert a Zod object schema into a plain JSON Schema object (draft 2020-12). */
function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>): ToolInputSchema {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const { $schema: _schema, ...rest } = jsonSchema;
  return rest;
}

const toolImpl = <Args extends z.ZodRawShape>(options: ToolOptions<Args>): ToolDefinition => {
  const schema = z.object(options.args);
  return {
    description: options.description,
    input: toJsonSchema(schema),
    /** Validate the input with Zod, then delegate to the tool implementation. */
    async execute(args, context) {
      const parsed = schema.parse(args ?? {});
      return await options.execute(parsed, context);
    },
  };
};

/**
 * Declare a tool for OpenCode 2.x.
 *
 * Mirrors the OpenCode 1.x `tool()` helper (including `tool.schema`) so existing
 * tool implementations only need to change their import path.
 */
export const tool: ToolFactory = Object.assign(toolImpl, { schema: z });

import { describe, expect, it } from "bun:test";
import { type ToolContext, tool } from "./tool";

const context: ToolContext = {
  sessionID: "session",
  agent: "novel",
  messageID: "message",
  id: "tool-call",
  signal: new AbortController().signal,
  progress: async () => {},
};

describe("tool", () => {
  it("converts zod args into a plain JSON Schema input", () => {
    const definition = tool({
      description: "demo tool",
      args: {
        name: tool.schema.string().describe("character name"),
        count: tool.schema.number().optional(),
      },
      execute: () => "ok",
    });

    expect(definition.description).toBe("demo tool");
    expect(definition.input).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", description: "character name" },
        count: { type: "number" },
      },
      required: ["name"],
    });
    expect(definition.input).not.toHaveProperty("$schema");
  });

  it("passes zod-parsed args to the implementation", async () => {
    const definition = tool({
      description: "echo",
      args: { name: tool.schema.string() },
      execute: (args) => `hello ${args.name}`,
    });

    await expect(definition.execute({ name: "Ada" }, context)).resolves.toBe("hello Ada");
  });

  it("rejects input that does not match the schema", async () => {
    const definition = tool({
      description: "echo",
      args: { name: tool.schema.string() },
      execute: () => "unreachable",
    });

    await expect(definition.execute({ name: 42 }, context)).rejects.toThrow();
  });
});

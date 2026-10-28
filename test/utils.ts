import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeLf } from "../src/shared/fs/write";
import type { ToolDefinition } from "../src/shared/plugin/tool";

export function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-novel-"));
  const run = async () => {
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return run();
}

export function writeFixtureFile(rootDir: string, relPath: string, content: string): string {
  const abs = path.join(rootDir, relPath.replaceAll("/", path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, normalizeLf(content), "utf8");
  return abs;
}

export function extractResultJson(markdownOutput: string): unknown {
  const match = markdownOutput.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error("No ```json block found in tool output");
  }
  return JSON.parse(match[1]);
}

export async function executeTool<Args extends object>(
  toolDef: ToolDefinition,
  args: Args,
): Promise<unknown> {
  const executable = toolDef as unknown as {
    execute: (args: Args) => unknown | Promise<unknown>;
  };
  return await executable.execute(args);
}

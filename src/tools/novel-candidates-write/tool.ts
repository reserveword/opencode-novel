import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import type { NovelCandidatesV1 } from "../novel-apply-candidates/types";
import type { NovelCandidatesWriteArgs, NovelCandidatesWriteResultJson } from "./types";

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnderDir(filePathAbs: string, dirAbs: string): boolean {
  const normalizedFile = path.resolve(filePathAbs).toLowerCase();
  const normalizedDir = path.resolve(dirAbs).toLowerCase();
  return (
    normalizedFile === normalizedDir ||
    normalizedFile.startsWith(normalizedDir + path.sep.toLowerCase())
  );
}

function parseCandidatesInput(input: unknown): { data: NovelCandidatesV1 | null; error?: string } {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { data: null, error: `JSON.parse 失败: ${message}` };
    }
  }

  if (!isPlainObject(parsed)) return { data: null, error: "candidates 不是对象" };
  const obj = parsed as Partial<NovelCandidatesV1> & PlainObject;

  if (obj.version !== 1) return { data: null, error: "candidates.version 必须为 1" };
  if (typeof obj.generatedAt !== "string" || obj.generatedAt.trim().length === 0) {
    return { data: null, error: "candidates.generatedAt 必须为非空 string" };
  }
  if (!isPlainObject(obj.scope) || typeof obj.scope.kind !== "string") {
    return { data: null, error: "candidates.scope 缺失或非法" };
  }
  if (!Array.isArray(obj.ops)) return { data: null, error: "candidates.ops 必须为数组" };

  return { data: obj as NovelCandidatesV1 };
}

export function createNovelCandidatesWriteTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description: "Write NovelCandidatesV1 JSON to cache/candidates.json (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      candidatesPath: tool.schema.string().optional(),
      candidates: tool.schema.unknown(),
    },
    async execute(args: NovelCandidatesWriteArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const candidatesPath = args.candidatesPath ?? `${deps.config.index.cacheDir}/candidates.json`;
      const candidatesPathAbs = path.isAbsolute(candidatesPath)
        ? candidatesPath
        : path.resolve(path.join(rootDir, candidatesPath));

      if (!isUnderDir(candidatesPathAbs, rootDir)) {
        diagnostics.push({
          severity: "error",
          code: "CANDIDATES_PATH_OUTSIDE_ROOT",
          message: `candidatesPath 不在 rootDir 下: ${candidatesPath}`,
          file: toRelativePosixPath(rootDir, candidatesPathAbs),
        });
      }

      const parsed = parseCandidatesInput(args.candidates);
      if (!parsed.data) {
        diagnostics.push({
          severity: "error",
          code: "CANDIDATES_INVALID",
          message: parsed.error ?? "candidates 非法",
          file: toRelativePosixPath(rootDir, candidatesPathAbs),
        });
      }

      if (diagnostics.some((d) => d.severity === "error")) {
        const durationMs = Date.now() - startedAt;
        const resultJson: NovelCandidatesWriteResultJson = { version: 1, diagnostics };
        return formatToolMarkdownOutput({
          summaryLines: ["status: failed", `durationMs: ${durationMs}`],
          resultJson,
          diagnostics,
        });
      }

      const rel = toRelativePosixPath(rootDir, candidatesPathAbs);
      const candidates = parsed.data as NovelCandidatesV1;
      const writeResult = writeTextFile(
        candidatesPathAbs,
        `${JSON.stringify(candidates, null, 2)}\n`,
        { mode: "always" },
      );

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelCandidatesWriteResultJson = {
        version: 1,
        candidatesPath: rel,
        changed: writeResult.changed,
        ops: candidates.ops.length,
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `candidatesPath: ${rel}`,
          `ops: ${candidates.ops.length}`,
          `changed: ${writeResult.changed}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

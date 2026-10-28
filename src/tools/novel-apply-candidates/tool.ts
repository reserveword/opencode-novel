import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { ensureDirForFile, writeTextFile } from "../../shared/fs/write";
import { buildFrontmatterFile, parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { slugify } from "../../shared/strings/slug";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { renderApplyReportMd } from "./render";
import type {
  CandidateOp,
  NovelApplyCandidatesArgs,
  NovelApplyCandidatesResultJson,
  NovelCandidatesV1,
} from "./types";

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type PatchMode = "deep_merge" | "shallow_merge";
type PatchOpName = "append_unique" | "remove" | "set";
type PatchOp = { $op: PatchOpName; values?: unknown[]; value?: unknown };

function normalizePatchMode(mode: unknown): PatchMode {
  if (mode === "replace" || mode === "shallow_merge") return "shallow_merge";
  return "deep_merge";
}

function isPatchOp(value: unknown): value is PatchOp {
  if (!isPlainObject(value)) return false;
  const op = (value as PlainObject).$op;
  return op === "append_unique" || op === "remove" || op === "set";
}

function mergeStringArraysUnique(base: string[], add: string[]): string[] {
  const out: string[] = [...base];
  const seen = new Set(base);
  for (const value of add) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function mergeArrays(base: unknown[], override: unknown[]): unknown[] {
  const baseStrings = base.every((v) => typeof v === "string");
  const overrideStrings = override.every((v) => typeof v === "string");
  if (baseStrings && overrideStrings) {
    return mergeStringArraysUnique(base as string[], override as string[]);
  }
  // For arrays of objects, default to override to avoid surprising de-dup semantics.
  return override;
}

function applyPatchOp(options: {
  current: unknown;
  op: PatchOp;
  diagnostics: Diagnostic[];
  file: string;
  keyPath: string;
}): unknown {
  const location = options.keyPath.length > 0 ? options.keyPath : "<root>";

  if (options.op.$op === "set") {
    if (!("value" in options.op)) {
      options.diagnostics.push({
        severity: "warn",
        code: "APPLY_PATCH_OP_INVALID",
        message: `patch op=set 缺少 value: ${location}`,
        file: options.file,
      });
      return options.current;
    }
    return options.op.value;
  }

  if (!Array.isArray(options.op.values)) {
    options.diagnostics.push({
      severity: "warn",
      code: "APPLY_PATCH_OP_INVALID",
      message: `patch op=${options.op.$op} 缺少 values[]: ${location}`,
      file: options.file,
    });
    return options.current;
  }

  const values = options.op.values;
  if (options.op.$op === "append_unique") {
    const base = Array.isArray(options.current) ? options.current : [];
    if (options.current !== undefined && !Array.isArray(options.current)) {
      options.diagnostics.push({
        severity: "warn",
        code: "APPLY_PATCH_OP_TYPE_MISMATCH",
        message: `patch op=append_unique 期望数组，但当前是 ${typeof options.current}: ${location}`,
        file: options.file,
      });
    }
    return mergeArrays(base, values);
  }

  // remove
  if (!Array.isArray(options.current)) {
    options.diagnostics.push({
      severity: "warn",
      code: "APPLY_PATCH_OP_TYPE_MISMATCH",
      message: `patch op=remove 期望数组，但当前不是数组: ${location}`,
      file: options.file,
    });
    return options.current;
  }

  const base = options.current;
  const baseStrings = base.every((v) => typeof v === "string");
  const valuesStrings = values.every((v) => typeof v === "string");
  if (baseStrings && valuesStrings) {
    const toRemove = new Set(values as string[]);
    return (base as string[]).filter((v) => !toRemove.has(v));
  }

  return base.filter((v) => !values.includes(v));
}

function mergeDeep(options: {
  current: unknown;
  patch: unknown;
  diagnostics: Diagnostic[];
  file: string;
  keyPath: string[];
}): unknown {
  if (options.patch === undefined) return options.current;

  if (isPatchOp(options.patch)) {
    return applyPatchOp({
      current: options.current,
      op: options.patch,
      diagnostics: options.diagnostics,
      file: options.file,
      keyPath: options.keyPath.join("."),
    });
  }

  if (Array.isArray(options.current) && Array.isArray(options.patch)) {
    return mergeArrays(options.current, options.patch);
  }

  if (isPlainObject(options.current) && isPlainObject(options.patch)) {
    const out: PlainObject = { ...options.current };
    for (const [k, v] of Object.entries(options.patch)) {
      out[k] = mergeDeep({
        current: (options.current as PlainObject)[k],
        patch: v,
        diagnostics: options.diagnostics,
        file: options.file,
        keyPath: [...options.keyPath, k],
      });
    }
    return out;
  }

  return options.patch;
}

function mergeShallow(options: {
  current: PlainObject;
  patch: PlainObject;
  diagnostics: Diagnostic[];
  file: string;
}): PlainObject {
  const out: PlainObject = { ...options.current };
  for (const [k, v] of Object.entries(options.patch)) {
    if (isPatchOp(v)) {
      out[k] = applyPatchOp({
        current: options.current[k],
        op: v,
        diagnostics: options.diagnostics,
        file: options.file,
        keyPath: k,
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseCandidates(raw: string): { data: NovelCandidatesV1 | null; error?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { data: null, error: "candidates 不是对象" };
    const obj = parsed as Partial<NovelCandidatesV1>;
    if (obj.version !== 1) return { data: null, error: "candidates.version 必须为 1" };
    if (!Array.isArray(obj.ops)) return { data: null, error: "candidates.ops 必须为数组" };
    if (typeof obj.generatedAt !== "string")
      return { data: null, error: "candidates.generatedAt 必须为 string" };
    if (!obj.scope || typeof obj.scope !== "object")
      return { data: null, error: "candidates.scope 缺失" };
    return { data: obj as NovelCandidatesV1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: `JSON.parse 失败: ${message}` };
  }
}

type EnsureEntityKind = Extract<CandidateOp, { op: "ensure_entity" }>["kind"];

function kindPlural(kind: EnsureEntityKind): string {
  if (kind === "character") return "characters";
  if (kind === "thread") return "threads";
  if (kind === "faction") return "factions";
  return "locations";
}

function isUnderDir(filePathAbs: string, dirAbs: string): boolean {
  const normalizedFile = path.resolve(filePathAbs).toLowerCase();
  const normalizedDir = path.resolve(dirAbs).toLowerCase();
  return (
    normalizedFile === normalizedDir ||
    normalizedFile.startsWith(normalizedDir + path.sep.toLowerCase())
  );
}

function toSnapshotTimestampUtc(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "_")
    .replaceAll(":", "-");
}

export function createNovelApplyCandidatesTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Apply LLM candidates safely: create missing entity files and patch YAML frontmatter only (never modify正文).",
    args: {
      rootDir: tool.schema.string().optional(),
      candidatesPath: tool.schema.string().optional(),
      dryRun: tool.schema.boolean().optional(),
      writeReport: tool.schema.boolean().optional(),
      snapshot: tool.schema.boolean().optional(),
      snapshotTag: tool.schema.string().optional(),
    },
    async execute(args: NovelApplyCandidatesArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const candidatesPath = args.candidatesPath ?? `${deps.config.index.cacheDir}/candidates.json`;
      const candidatesPathAbs = path.isAbsolute(candidatesPath)
        ? candidatesPath
        : path.resolve(path.join(rootDir, candidatesPath));
      const dryRun = args.dryRun ?? true;
      const writeReport = args.writeReport ?? true;

      let raw: string;
      try {
        raw = readFileSync(candidatesPathAbs, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          severity: "error",
          code: "APPLY_READ_CANDIDATES_FAIL",
          message: `读取 candidates 失败: ${message}`,
          file: toRelativePosixPath(rootDir, candidatesPathAbs),
        });
        const resultJson: NovelApplyCandidatesResultJson = {
          version: 1,
          dryRun,
          appliedOps: 0,
          writtenFiles: [],
          skippedOps: [],
          diagnostics,
        };
        return formatToolMarkdownOutput({
          summaryLines: ["status: failed"],
          resultJson,
          diagnostics,
        });
      }

      const parsed = parseCandidates(raw);
      if (!parsed.data) {
        diagnostics.push({
          severity: "error",
          code: "APPLY_INVALID_CANDIDATES",
          message: parsed.error ?? "candidates 无效",
          file: toRelativePosixPath(rootDir, candidatesPathAbs),
        });
        const resultJson: NovelApplyCandidatesResultJson = {
          version: 1,
          dryRun,
          appliedOps: 0,
          writtenFiles: [],
          skippedOps: [],
          diagnostics,
        };
        return formatToolMarkdownOutput({
          summaryLines: ["status: failed"],
          resultJson,
          diagnostics,
        });
      }

      const manuscriptDirAbs = path.resolve(path.join(rootDir, deps.config.manuscriptDir));
      const snapshotEnabled = !dryRun && (args.snapshot ?? false);
      const snapshotTag = (args.snapshotTag ?? "").trim() || undefined;
      const snapshotSavedFiles: string[] = [];
      const snapshotDirAbs = snapshotEnabled
        ? path.join(
            manuscriptDirAbs,
            "snapshots",
            `${toSnapshotTimestampUtc()}-apply${snapshotTag ? `-${slugify(snapshotTag)}` : ""}`,
          )
        : undefined;
      const snapshottedFiles = new Set<string>();

      const snapshotFile = (absPath: string) => {
        if (!snapshotEnabled || !snapshotDirAbs) return;
        if (!existsSync(absPath)) return;

        const key = path.resolve(absPath).toLowerCase();
        if (snapshottedFiles.has(key)) return;
        snapshottedFiles.add(key);

        const relUnderManuscript = path.relative(manuscriptDirAbs, absPath);
        const destAbs = path.join(snapshotDirAbs, relUnderManuscript);
        ensureDirForFile(destAbs);
        copyFileSync(absPath, destAbs);
        snapshotSavedFiles.push(toRelativePosixPath(rootDir, destAbs));
      };

      if (snapshotEnabled && snapshotDirAbs) {
        const destAbs = path.join(snapshotDirAbs, "candidates.json");
        ensureDirForFile(destAbs);
        try {
          copyFileSync(candidatesPathAbs, destAbs);
          snapshotSavedFiles.push(toRelativePosixPath(rootDir, destAbs));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            severity: "warn",
            code: "APPLY_SNAPSHOT_COPY_FAILED",
            message: `快照保存 candidates 失败: ${message}`,
            file: toRelativePosixPath(rootDir, candidatesPathAbs),
          });
        }
      }
      const writtenFiles: string[] = [];
      const skippedOps: { index: number; reason: string }[] = [];
      let appliedOps = 0;

      type AnyCandidateOp = { op: string } & Record<string, unknown>;
      const ops = parsed.data.ops as unknown[];
      for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i] as AnyCandidateOp;
        if (!op || typeof op !== "object" || typeof op.op !== "string") {
          skippedOps.push({ index: i, reason: "op 非法" });
          continue;
        }

        if (op.op === "ensure_entity") {
          if (
            !("kind" in op) ||
            !("id" in op) ||
            typeof op.kind !== "string" ||
            typeof op.id !== "string"
          ) {
            skippedOps.push({ index: i, reason: "ensure_entity 缺少 kind/id" });
            continue;
          }
          const kind = op.kind as EnsureEntityKind;
          const id = op.id;
          const name = typeof op.name === "string" ? op.name : undefined;
          const rel =
            typeof op.filePath === "string"
              ? op.filePath
              : `${deps.config.manuscriptDir}/${kindPlural(kind)}/${id}.md`;
          const abs = path.isAbsolute(rel)
            ? rel
            : path.join(rootDir, rel.replaceAll("/", path.sep));

          if (!isUnderDir(abs, manuscriptDirAbs)) {
            diagnostics.push({
              severity: "error",
              code: "APPLY_PATH_OUTSIDE_MANUSCRIPT",
              message: `ensure_entity 目标不在 manuscript/**: ${rel}`,
            });
            skippedOps.push({ index: i, reason: "目标不在 manuscript/**" });
            continue;
          }

          if (existsSync(abs)) {
            skippedOps.push({ index: i, reason: "文件已存在" });
            continue;
          }

          const content =
            kind === "thread"
              ? buildFrontmatterFile(
                  { thread_id: id, type: "mystery", status: "open", close_plan: "TODO" },
                  `# ${id}\n\n## TODO\n- 补全该线程的提出点/推进点/回收计划\n`,
                )
              : buildFrontmatterFile(
                  { id, name: name ?? id },
                  `# ${name ?? id}\n\n## TODO\n- 补全该实体的关键信息\n`,
                );

          if (!dryRun) {
            writeTextFile(abs, content, { mode: "always" });
          }
          writtenFiles.push(toRelativePosixPath(rootDir, abs));
          appliedOps += 1;
          continue;
        }

        if (op.op === "patch_frontmatter") {
          if (typeof op.filePath !== "string" || !("patch" in op) || !isPlainObject(op.patch)) {
            skippedOps.push({ index: i, reason: "patch_frontmatter 缺少 filePath/patch" });
            continue;
          }
          const rel = op.filePath;
          const abs = path.isAbsolute(rel)
            ? rel
            : path.join(rootDir, rel.replaceAll("/", path.sep));

          if (!isUnderDir(abs, manuscriptDirAbs)) {
            diagnostics.push({
              severity: "error",
              code: "APPLY_PATH_OUTSIDE_MANUSCRIPT",
              message: `patch_frontmatter 目标不在 manuscript/**: ${rel}`,
            });
            skippedOps.push({ index: i, reason: "目标不在 manuscript/**" });
            continue;
          }

          const exists = existsSync(abs);
          if (!exists) {
            skippedOps.push({ index: i, reason: "目标文件不存在" });
            continue;
          }

          const content = readTextFileSync(abs, { encoding: deps.config.encoding });
          const parsedFm = parseFrontmatter<Record<string, unknown>>(content, {
            file: rel,
            strict: false,
          });

          const currentData = isPlainObject(parsedFm.data) ? (parsedFm.data as PlainObject) : {};
          const mode = normalizePatchMode(op.mode);
          const patch = op.patch as PlainObject;
          const nextData =
            mode === "shallow_merge"
              ? mergeShallow({ current: currentData, patch, diagnostics, file: rel })
              : (mergeDeep({
                  current: currentData,
                  patch,
                  diagnostics,
                  file: rel,
                  keyPath: [],
                }) as PlainObject);

          const rebuilt = buildFrontmatterFile(nextData, parsedFm.body);

          if (!dryRun) {
            snapshotFile(abs);
            writeTextFile(abs, rebuilt, { mode: "always" });
          }
          writtenFiles.push(toRelativePosixPath(rootDir, abs));
          appliedOps += 1;
          continue;
        }

        skippedOps.push({ index: i, reason: `未知 op: ${op.op}` });
      }

      const reportPathAbs = path.join(rootDir, deps.config.index.outputDir, "APPLY_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);

      const resultJson: NovelApplyCandidatesResultJson = {
        version: 1,
        dryRun,
        appliedOps,
        writtenFiles: Array.from(new Set(writtenFiles)).sort(),
        skippedOps,
        snapshot: snapshotEnabled
          ? {
              enabled: true,
              tag: snapshotTag,
              dir: snapshotDirAbs ? toRelativePosixPath(rootDir, snapshotDirAbs) : undefined,
              savedFiles: Array.from(new Set(snapshotSavedFiles)).sort(),
            }
          : undefined,
        nextSteps: dryRun
          ? ["确认无误后运行：/novel-apply-candidates（dryRun=false；建议 snapshot=true）"]
          : [
              "/novel-index（更新 INDEX/TIMELINE/THREADS_REPORT）",
              "/novel-continuity-check（复核一致性）",
            ],
        reportPath: writeReport ? reportPathRel : undefined,
        diagnostics,
      };

      if (writeReport) {
        writeTextFile(reportPathAbs, renderApplyReportMd(resultJson), { mode: "if-changed" });
      }

      const durationMs = Date.now() - startedAt;
      return formatToolMarkdownOutput({
        summaryLines: [
          `dryRun: ${dryRun}`,
          `appliedOps: ${appliedOps}`,
          `writtenFiles: ${resultJson.writtenFiles.length}`,
          `snapshot: ${
            resultJson.snapshot
              ? `${resultJson.snapshot.dir ?? "(unknown)"} (${resultJson.snapshot.savedFiles.length})`
              : "disabled"
          }`,
          `skippedOps: ${skippedOps.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

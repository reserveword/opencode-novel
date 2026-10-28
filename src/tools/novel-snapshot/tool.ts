import { copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { ensureDirForFile, writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { slugify } from "../../shared/strings/slug";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import type { NovelSnapshotArgs, NovelSnapshotEntry, NovelSnapshotResultJson } from "./types";

function toSnapshotTimestampUtc(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "_")
    .replaceAll(":", "-");
}

function listFilesRecursively(rootDir: string): string[] {
  const result: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        result.push(abs);
      }
    }
  }
  return result;
}

function renderSnapshotMd(options: {
  tag: string;
  createdAt: string;
  snapshotDir: string;
  entries: NovelSnapshotEntry[];
}): string {
  const header = "<!-- novel:snapshot v1; DO NOT EDIT BY HAND -->";
  const lines: string[] = [header, "", "# SNAPSHOT", ""];

  lines.push("## Meta", "");
  lines.push(`- tag: ${options.tag}`);
  lines.push(`- createdAt: ${options.createdAt}`);
  lines.push(`- snapshotDir: ${options.snapshotDir}`);
  lines.push("");

  lines.push("## Files", "");
  lines.push("| source | dest |");
  lines.push("| --- | --- |");
  for (const e of options.entries) {
    lines.push(`| ${e.source} | ${e.dest} |`);
  }
  lines.push("");

  lines.push("## Restore (Manual)", "");
  lines.push("- 将 snapshot 中的文件复制回对应 source 路径（或使用 git 进行回滚）。");
  lines.push("");

  return lines.join("\n");
}

export function createNovelSnapshotTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Create a lightweight snapshot of key bible + derived reports into manuscript/snapshots/ (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      tag: tool.schema.string().optional(),
      includeBible: tool.schema.boolean().optional(),
      includeDerived: tool.schema.boolean().optional(),
    },
    async execute(args: NovelSnapshotArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const manuscriptDirAbs = path.resolve(path.join(rootDir, manuscriptDirName));
      const outputDirAbs = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));

      const includeBible = args.includeBible ?? true;
      const includeDerived = args.includeDerived ?? true;

      const tag = (args.tag ?? "").trim() || "snapshot";
      const timestamp = toSnapshotTimestampUtc();
      const snapshotDirAbs = path.join(
        manuscriptDirAbs,
        "snapshots",
        `${timestamp}-${slugify(tag)}`,
      );
      const snapshotDirRel = toRelativePosixPath(rootDir, snapshotDirAbs);

      const entries: NovelSnapshotEntry[] = [];
      const savedFiles: string[] = [];

      const copyOne = (sourceAbs: string, destAbs: string, code: string) => {
        try {
          ensureDirForFile(destAbs);
          copyFileSync(sourceAbs, destAbs);
          const sourceRel = toRelativePosixPath(rootDir, sourceAbs);
          const destRel = toRelativePosixPath(rootDir, destAbs);
          entries.push({ source: sourceRel, dest: destRel });
          savedFiles.push(destRel);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            severity: "warn",
            code,
            message: `复制失败: ${message}`,
            file: toRelativePosixPath(rootDir, sourceAbs),
          });
        }
      };

      if (includeBible) {
        const bibleDirAbs = path.join(manuscriptDirAbs, "bible");
        if (!existsSync(bibleDirAbs)) {
          diagnostics.push({
            severity: "info",
            code: "SNAPSHOT_BIBLE_MISSING",
            message: "manuscript/bible 不存在，已跳过。",
            file: toRelativePosixPath(rootDir, bibleDirAbs),
          });
        } else {
          for (const abs of listFilesRecursively(bibleDirAbs)) {
            const relUnder = path.relative(bibleDirAbs, abs);
            const destAbs = path.join(snapshotDirAbs, "bible", relUnder);
            copyOne(abs, destAbs, "SNAPSHOT_COPY_BIBLE_FAILED");
          }
        }
      }

      if (includeDerived) {
        const derivedFiles = [
          "INDEX.md",
          "TIMELINE.md",
          "THREADS_REPORT.md",
          "CONTINUITY_REPORT.md",
          "FORESHADOWING_AUDIT.md",
          "STYLE_REPORT.md",
          "ENTITY_GAPS.md",
          "IMPORT_REPORT.md",
          "APPLY_REPORT.md",
          "CHARACTER_REPORT.md",
          path.join("GRAPH", "RELATIONSHIPS.mmd"),
          path.join("GRAPH", "FACTIONS.mmd"),
        ];

        if (!existsSync(outputDirAbs)) {
          diagnostics.push({
            severity: "info",
            code: "SNAPSHOT_DERIVED_DIR_MISSING",
            message: "派生目录 outputDir 不存在，已跳过。",
            file: toRelativePosixPath(rootDir, outputDirAbs),
          });
        } else {
          for (const rel of derivedFiles) {
            const sourceAbs = path.join(outputDirAbs, rel);
            if (!existsSync(sourceAbs)) continue;
            const destAbs = path.join(snapshotDirAbs, "derived", rel);
            copyOne(sourceAbs, destAbs, "SNAPSHOT_COPY_DERIVED_FAILED");
          }
        }
      }

      const createdAt = new Date().toISOString();
      const snapshotMdAbs = path.join(snapshotDirAbs, "SNAPSHOT.md");
      const snapshotMdRel = toRelativePosixPath(rootDir, snapshotMdAbs);
      const snapshotMd = renderSnapshotMd({
        tag,
        createdAt,
        snapshotDir: snapshotDirRel,
        entries: entries.sort((a, b) => a.dest.localeCompare(b.dest)),
      });
      writeTextFile(snapshotMdAbs, snapshotMd, { mode: "always" });
      savedFiles.push(snapshotMdRel);

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelSnapshotResultJson = {
        version: 1,
        tag,
        snapshotDir: snapshotDirRel,
        entries: entries.sort((a, b) => a.dest.localeCompare(b.dest)),
        savedFiles: Array.from(new Set(savedFiles)).sort((a, b) => a.localeCompare(b)),
        stats: { durationMs, savedFiles: Array.from(new Set(savedFiles)).length },
        nextSteps: [
          "/novel-export（导出交付）",
          `如需回滚：按 ${snapshotDirRel}/SNAPSHOT.md 中的表格手动复制回源路径（或用 git）。`,
        ],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `tag: ${tag}`,
          `snapshotDir: ${snapshotDirRel}`,
          `savedFiles: ${resultJson.savedFiles.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

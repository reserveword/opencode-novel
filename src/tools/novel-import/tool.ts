import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { hash8 } from "../../shared/hashing/hash8";
import { buildFrontmatterFile } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { parseChineseNumber } from "../../shared/strings/chinese-number";
import { slugify } from "../../shared/strings/slug";
import { TEXT_ENCODINGS } from "../../shared/strings/text-encoding";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { ensureNovelScaffold } from "../novel-scaffold/scaffold";
import type {
  ImportMapItem,
  NovelImportArgs,
  NovelImportMode,
  NovelImportResultJson,
} from "./types";

type ChapterHeadingHit = {
  lineIndex: number;
  headingLine: string;
  title: string;
  numeric?: number;
  warnings: string[];
};

/** 生成当前时刻的 UTC ISO 时间戳。 */
function toUtcIsoNow(): string {
  return new Date().toISOString();
}

/** 深度遍历目录并收集文件列表，同时在目录层级做排除裁剪。 */
function walkFiles(
  root: string,
  options: { excludeMatchers: Array<(p: string) => boolean> },
): string[] {
  const result: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = toRelativePosixPath(root, abs);
      if (entry.isDirectory()) {
        // Performance: prune excluded directories before descending.
        if (isMatchedAny(options.excludeMatchers, rel)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        result.push(abs);
      }
    }
  }

  return result;
}

/** 将 glob 模式编译成可复用的匹配函数。 */
function compileMatchers(globs: string[]): Array<(p: string) => boolean> {
  return globs.map((g) => picomatch(g, { dot: true }));
}

/** 判断路径是否命中任意匹配器。 */
function isMatchedAny(matchers: Array<(p: string) => boolean>, relPosixPath: string): boolean {
  return matchers.some((m) => m(relPosixPath));
}

/** 从正文行中识别章节标题并返回命中结果。 */
function detectChaptersFromContent(options: {
  lines: string[];
  strongPatterns: RegExp[];
  enableLooseAfterStrong: boolean;
}): ChapterHeadingHit[] {
  const hits: ChapterHeadingHit[] = [];
  let sawStrong = false;

  const looseH1 = /^\s*#\s+(.+)$/;

  for (let i = 0; i < options.lines.length; i += 1) {
    const line = options.lines[i];
    let strongMatched: RegExpMatchArray | null = null;
    let strongPattern: RegExp | null = null;
    for (const pattern of options.strongPatterns) {
      const match = line.match(pattern);
      if (match) {
        strongMatched = match;
        strongPattern = pattern;
        break;
      }
    }

    if (strongMatched && strongPattern) {
      sawStrong = true;
      const warnings: string[] = [];

      const rawNumber = strongMatched[1] ?? "";
      const rawTitle = (strongMatched[2] ?? "").trim();

      const numeric = parseChineseNumber(rawNumber);
      if (numeric === null) {
        warnings.push(`无法解析章节编号: ${rawNumber}`);
      }

      const title = rawTitle.length > 0 ? rawTitle : line.trim();
      hits.push({
        lineIndex: i,
        headingLine: line,
        title,
        numeric: numeric ?? undefined,
        warnings,
      });
      continue;
    }

    if (sawStrong && options.enableLooseAfterStrong) {
      const match = line.match(looseH1);
      if (match) {
        const title = match[1].trim();
        if (title.length === 0) continue;
        hits.push({
          lineIndex: i,
          headingLine: line,
          title,
          warnings: ["使用松匹配 H1 作为章节分割"],
        });
      }
    }
  }

  return hits;
}

/** 当正文未识别到章节标题时，尝试使用文件名作为章节标题来源。 */
function detectChapterFromFilename(options: {
  fileStem: string;
  strongPatterns: RegExp[];
}): ChapterHeadingHit | null {
  const fileStem = options.fileStem.trim();
  if (fileStem.length === 0) return null;

  const strong = detectChaptersFromContent({
    lines: [fileStem],
    strongPatterns: options.strongPatterns,
    enableLooseAfterStrong: false,
  });
  if (strong.length > 0) {
    const first = strong[0];
    return {
      ...first,
      lineIndex: -1,
      headingLine: fileStem,
      warnings: [...first.warnings, "正文未检测到章节标题，已回退使用文件名。"],
    };
  }

  return {
    lineIndex: -1,
    headingLine: fileStem,
    title: fileStem,
    warnings: ["正文未检测到章节标题，已回退使用文件名。"],
  };
}

/** 基于章节编号或标题生成稳定的章节 ID。 */
function buildChapterId(options: {
  numeric?: number;
  title: string;
  prefix: string;
  pad: number;
  specialPrefix: string;
}): string {
  if (
    typeof options.numeric === "number" &&
    Number.isFinite(options.numeric) &&
    options.numeric > 0
  ) {
    const n = Math.floor(options.numeric);
    return `${options.prefix}${String(n).padStart(options.pad, "0")}`;
  }
  const slug = slugify(options.title).slice(0, 32);
  const finalSlug = slug.length > 0 ? slug : hash8(options.title);
  return `${options.specialPrefix}-${finalSlug}`;
}

/** 去除章节标题行，仅保留正文内容；当标题来自文件名时保留全文。 */
function stripHeadingLine(lines: string[], headingLineIndex: number, endExclusive: number): string {
  if (headingLineIndex < 0) {
    return lines.join("\n").replace(/^\n+/, "").trimEnd();
  }
  const bodyLines = lines.slice(headingLineIndex + 1, endExclusive);
  return bodyLines.join("\n").replace(/^\n+/, "").trimEnd();
}

/** 渲染导入报告 Markdown。 */
function renderImportReport(options: {
  imported: ImportMapItem[];
  conflicts: { chapter_id: string; existing: string; written: string }[];
  unclassified: { source_path: string; reason: string }[];
}): string {
  const header = "<!-- novel:derived v1; DO NOT EDIT BY HAND -->";
  const lines: string[] = [header, "", "# IMPORT REPORT", ""];

  lines.push("## Summary");
  lines.push(
    `- importedChapters: ${options.imported.length}`,
    `- conflicts: ${options.conflicts.length}`,
    `- unclassified: ${options.unclassified.length}`,
    "",
  );

  lines.push("## Imported Chapters");
  lines.push("");
  lines.push("| chapter_id | title | source | output |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of options.imported) {
    lines.push(
      `| ${item.chapter_id} | ${item.title ?? ""} | ${item.source_path} | ${item.output_path} |`,
    );
  }
  lines.push("");

  lines.push("## Conflicts");
  lines.push("");
  lines.push("| chapter_id | existing | written |");
  lines.push("| --- | --- | --- |");
  for (const c of options.conflicts) {
    lines.push(`| ${c.chapter_id} | ${c.existing} | ${c.written} |`);
  }
  lines.push("");

  lines.push("## Unclassified");
  for (const u of options.unclassified) {
    lines.push(`- ${u.source_path}: ${u.reason}`);
  }
  lines.push("");

  lines.push("## Next Steps");
  lines.push("- 运行 /novel-index 生成派生索引");
  lines.push("- 运行 /novel-entities-audit --stubs 补齐缺口（可选）");
  lines.push("- 创建/完善角色卡与线程卡（manuscript/characters、manuscript/threads）");
  lines.push("");

  return lines.join("\n");
}

/** 创建小说导入工具定义。 */
export function createNovelImportTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Import an existing novel directory into manuscript/ structure without modifying original files.",
    args: {
      rootDir: tool.schema.string().optional(),
      fromDir: tool.schema.string().optional(),
      mode: tool.schema.enum(["copy", "analyze"]).optional(),
      manuscriptDir: tool.schema.string().optional(),
      encoding: tool.schema.enum(TEXT_ENCODINGS).optional(),
      includeGlobs: tool.schema.array(tool.schema.string()).optional(),
      excludeGlobs: tool.schema.array(tool.schema.string()).optional(),
      writeConfigJsonc: tool.schema.boolean().optional(),
      writeReport: tool.schema.boolean().optional(),
    },
    /** 执行导入流程：扫描源文件、识别章节并写入规范化章节文件。 */
    async execute(args: NovelImportArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const fromDir = path.resolve(args.fromDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const mode: NovelImportMode = args.mode ?? deps.config.import.defaultMode;
      const encoding = args.encoding ?? deps.config.encoding;
      const writeConfigJsonc = args.writeConfigJsonc ?? true;
      const writeReport = args.writeReport ?? true;

      const includeGlobs = args.includeGlobs ?? deps.config.import.includeGlobs;
      const excludeGlobs = Array.from(
        new Set([
          ...(args.excludeGlobs ?? deps.config.import.excludeGlobs),
          "manuscript/**",
          ".opencode/**",
        ]),
      );

      const includeMatchers = compileMatchers(includeGlobs);
      const excludeMatchers = compileMatchers(excludeGlobs);

      const patternDefs = deps.config.import.chapterDetection.patterns;
      const strongPatterns: RegExp[] = [];
      for (const p of patternDefs) {
        try {
          strongPatterns.push(new RegExp(p.regex, p.flags ?? ""));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            severity: "error",
            code: "IMPORT_INVALID_REGEX",
            message: `无效章节识别正则(${p.id}): ${message}`,
          });
        }
      }

      const enableLooseAfterStrong =
        deps.config.import.chapterDetection.enableLooseH1AfterFirstMatch;

      const sourceFiles = walkFiles(fromDir, { excludeMatchers })
        .filter((abs) => abs.endsWith(".md") || abs.endsWith(".txt"))
        .filter((abs) => {
          const relFromFrom = toRelativePosixPath(fromDir, abs);
          if (!isMatchedAny(includeMatchers, relFromFrom)) return false;
          if (isMatchedAny(excludeMatchers, relFromFrom)) return false;
          return true;
        })
        .sort((a, b) => a.localeCompare(b));

      if (mode === "copy") {
        ensureNovelScaffold({
          rootDir,
          manuscriptDirName,
          config: deps.config,
          writeConfigJsonc,
          writeTemplates: true,
          forceOverwriteTemplates: false,
        });
      }

      const importedAt = toUtcIsoNow();

      const importMap: ImportMapItem[] = [];
      const writtenChapters: string[] = [];
      const conflicts: { chapter_id: string; existing: string; written: string }[] = [];
      const unclassified: { source_path: string; reason: string }[] = [];

      for (const absPath of sourceFiles) {
        let raw: string;
        try {
          raw = readTextFileSync(absPath, { encoding });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            severity: "error",
            code: "IMPORT_READ_FAIL",
            message: `读取失败: ${message}`,
            file: toRelativePosixPath(rootDir, absPath),
          });
          continue;
        }

        const stat = statSync(absPath);
        void stat;

        const sourceType: "md" | "txt" = absPath.endsWith(".txt") ? "txt" : "md";
        const sourceRelRoot = toRelativePosixPath(rootDir, absPath);
        const lines = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

        let hits = detectChaptersFromContent({
          lines,
          strongPatterns,
          enableLooseAfterStrong,
        });

        if (hits.length === 0) {
          const fallbackHit = detectChapterFromFilename({
            fileStem: path.parse(absPath).name,
            strongPatterns,
          });
          if (fallbackHit) {
            hits = [fallbackHit];
          }
        }

        if (hits.length === 0) {
          unclassified.push({ source_path: sourceRelRoot, reason: "未找到章节标题" });
          continue;
        }

        // Ensure deterministic ordering by line index
        hits.sort((a, b) => a.lineIndex - b.lineIndex);

        for (let i = 0; i < hits.length; i += 1) {
          const hit = hits[i];
          const endExclusive = i + 1 < hits.length ? hits[i + 1].lineIndex : lines.length;

          const chapterId = buildChapterId({
            numeric: hit.numeric,
            title: hit.title,
            prefix: deps.config.import.chapterId.prefix,
            pad: deps.config.import.chapterId.pad,
            specialPrefix: deps.config.import.chapterId.specialPrefix,
          });

          const title = hit.title.trim() ? hit.title.trim() : hit.headingLine.trim();
          const chapterBody = stripHeadingLine(lines, hit.lineIndex, endExclusive);
          const sourceHeadingLine = hit.lineIndex >= 0 ? hit.lineIndex + 1 : 0;
          const sourceStartLine = hit.lineIndex >= 0 ? hit.lineIndex + 1 : 1;
          const sourceEndLine = hit.lineIndex >= 0 ? endExclusive : lines.length;

          const targetBase = path.join(rootDir, manuscriptDirName, "chapters", `${chapterId}.md`);
          const targetRel = toRelativePosixPath(rootDir, targetBase);

          let outputPathAbs = targetBase;
          let outputPathRel = targetRel;

          if (existsSync(targetBase)) {
            const suffix = hash8(`${sourceRelRoot}:${hit.lineIndex}:${chapterId}`);
            const conflictAbs = path.join(
              rootDir,
              manuscriptDirName,
              "chapters",
              `${chapterId}.import-${suffix}.md`,
            );
            const conflictRel = toRelativePosixPath(rootDir, conflictAbs);
            conflicts.push({ chapter_id: chapterId, existing: targetRel, written: conflictRel });
            outputPathAbs = conflictAbs;
            outputPathRel = conflictRel;
          }

          const fm = {
            chapter_id: chapterId,
            title,
            source: {
              imported_from: sourceRelRoot,
              imported_at: importedAt,
            },
          };
          const fullBody = `# ${title}\n\n${chapterBody}\n`;
          const outputContent = buildFrontmatterFile(fm, fullBody);

          const item: ImportMapItem = {
            chapter_id: chapterId,
            title,
            source_path: sourceRelRoot,
            source_type: sourceType,
            source_heading_line: sourceHeadingLine,
            source_range: { startLine: sourceStartLine, endLine: sourceEndLine },
            output_path: outputPathRel,
            warnings: hit.warnings.length > 0 ? hit.warnings : undefined,
          };
          importMap.push(item);

          if (mode === "copy") {
            if (!existsSync(outputPathAbs)) {
              writeTextFile(outputPathAbs, outputContent, { mode: "always" });
              writtenChapters.push(outputPathRel);
            }
          }
        }
      }

      importMap.sort(
        (a, b) =>
          a.chapter_id.localeCompare(b.chapter_id) || a.output_path.localeCompare(b.output_path),
      );
      conflicts.sort((a, b) => a.chapter_id.localeCompare(b.chapter_id));
      unclassified.sort((a, b) => a.source_path.localeCompare(b.source_path));
      writtenChapters.sort();

      const cacheDir = path.join(rootDir, deps.config.index.cacheDir);
      const importMapPathAbs = path.join(cacheDir, "import-map.json");
      const importMapPathRel = toRelativePosixPath(rootDir, importMapPathAbs);
      writeTextFile(importMapPathAbs, `${JSON.stringify(importMap, null, 2)}\n`, {
        mode: "always",
      });

      const reportPathAbs = path.join(rootDir, deps.config.index.outputDir, "IMPORT_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);
      if (writeReport) {
        const report = renderImportReport({ imported: importMap, conflicts, unclassified });
        writeTextFile(reportPathAbs, report, { mode: "always" });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelImportResultJson = {
        version: 1,
        mode,
        fromDir: toRelativePosixPath(rootDir, fromDir),
        manuscriptDir: manuscriptDirName,
        writtenChapters,
        conflicts,
        unclassified,
        reportPath: writeReport ? reportPathRel : undefined,
        importMapPath: importMapPathRel,
        nextSteps: [
          "/novel-index（生成 INDEX/TIMELINE/THREADS_REPORT）",
          "/novel-entities-audit --stubs（可选：自动补 stub）",
          "/novel-extract-entities（生成 candidates.json）",
        ],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `mode: ${mode}`,
          `sourceFiles: ${sourceFiles.length}`,
          `importedChapters: ${importMap.length}`,
          `writtenChapters: ${writtenChapters.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

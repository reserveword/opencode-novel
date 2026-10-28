import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic, DiagnosticEvidence } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderStyleReportMd } from "./render";
import type { NovelStyleArgs, NovelStyleResultJson, NovelStyleScope, StyleFinding } from "./types";

function findOccurrences(text: string, needle: string): number[] {
  const indexes: number[] = [];
  if (!needle) return indexes;
  let fromIndex = 0;
  while (true) {
    const idx = text.indexOf(needle, fromIndex);
    if (idx === -1) break;
    indexes.push(idx);
    fromIndex = idx + needle.length;
  }
  return indexes;
}

function excerptAround(text: string, index: number, maxLen: number): string {
  const start = Math.max(0, index - Math.floor(maxLen / 2));
  const end = Math.min(text.length, start + maxLen);
  return text.slice(start, end).replaceAll("\n", " ").trim();
}

function buildEvidence(file: string, content: string, needle: string): DiagnosticEvidence {
  const idx = content.indexOf(needle);
  return {
    file,
    excerpt: idx >= 0 ? excerptAround(content, idx, 180) : undefined,
  };
}

function resolveScopeChapters(
  scanChapters: Array<{ chapter_id: string; path: string; characters?: string[] }>,
  scope?: NovelStyleScope,
): Array<{ chapter_id: string; path: string }> {
  if (!scope || scope.kind === "all") {
    return scanChapters.map((c) => ({ chapter_id: c.chapter_id, path: c.path }));
  }
  if (scope.kind === "chapter") {
    const found = scanChapters.find((c) => c.chapter_id === scope.chapter_id);
    return found ? [{ chapter_id: found.chapter_id, path: found.path }] : [];
  }
  const targetId = scope.id;
  return scanChapters
    .filter((c) => (c.characters ?? []).includes(targetId))
    .map((c) => ({ chapter_id: c.chapter_id, path: c.path }));
}

export function createNovelStyleCheckTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Basic style consistency checks (lexicon avoid/preferred + simple voice statistics).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      scope: tool.schema
        .union([
          tool.schema.object({ kind: tool.schema.literal("all") }),
          tool.schema.object({
            kind: tool.schema.literal("chapter"),
            chapter_id: tool.schema.string(),
          }),
          tool.schema.object({ kind: tool.schema.literal("character"), id: tool.schema.string() }),
        ])
        .optional(),
      catchphraseMaxCount: tool.schema.number().int().nonnegative().optional(),
      catchphraseReportMissing: tool.schema.boolean().optional(),
      writeReport: tool.schema.boolean().optional(),
    },
    async execute(args: NovelStyleArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;
      const catchphraseMaxCount =
        args.catchphraseMaxCount ?? deps.config.styleGuide.checks.catchphrase.maxCount;
      const catchphraseReportMissing =
        args.catchphraseReportMissing ?? deps.config.styleGuide.checks.catchphrase.reportMissing;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const chapters = resolveScopeChapters(scan.entities.chapters, args.scope);
      if (chapters.length === 0) {
        diagnostics.push({
          severity: "warn",
          code: "STYLE_SCOPE_EMPTY",
          message: "scope 未匹配到任何章节。",
        });
      }

      const avoidWords = deps.config.styleGuide.lexicon.avoid ?? [];

      const findings: StyleFinding[] = [];

      const chapterBodyCache = new Map<string, string>();
      const getChapterBody = (chapterPath: string): string => {
        if (chapterBodyCache.has(chapterPath)) return chapterBodyCache.get(chapterPath) ?? "";

        const abs = fromRelativePosixPath(rootDir, chapterPath);
        if (!existsSync(abs)) {
          chapterBodyCache.set(chapterPath, "");
          return "";
        }

        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: chapterPath,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        chapterBodyCache.set(chapterPath, parsed.body);
        return parsed.body;
      };

      for (const chapter of chapters) {
        const body = getChapterBody(chapter.path);
        if (!body) continue;

        for (const word of avoidWords) {
          if (!word) continue;
          const occurrences = findOccurrences(body, word);
          if (occurrences.length === 0) continue;
          findings.push({
            severity: "warn",
            code: "STYLE_AVOID_WORD",
            message: `命中禁用词: ${word} (count=${occurrences.length})`,
            evidence: [buildEvidence(chapter.path, body, word)],
            suggestedFix: "替换或删除禁用词，或在 styleGuide.lexicon.avoid 中移除该词。",
          });
        }
      }

      // Voice catchphrases statistics (info)
      const chapterPathsByCharacter = new Map<string, string[]>();
      for (const chapter of scan.entities.chapters) {
        for (const id of chapter.characters ?? []) {
          const list = chapterPathsByCharacter.get(id) ?? [];
          list.push(chapter.path);
          chapterPathsByCharacter.set(id, list);
        }
      }

      for (const character of scan.entities.characters) {
        const abs = fromRelativePosixPath(rootDir, character.path);
        if (!existsSync(abs)) continue;
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: character.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);
        const voice = parsed.data.voice;
        if (!voice || typeof voice !== "object") continue;
        const rawCatchphrases = (voice as Record<string, unknown>).catchphrases;
        const catchphrases = Array.isArray(rawCatchphrases)
          ? rawCatchphrases.filter((x): x is string => typeof x === "string")
          : [];
        if (catchphrases.length === 0) continue;

        const relatedPaths = chapterPathsByCharacter.get(character.id) ?? [];
        const corpus = relatedPaths.map(getChapterBody).filter(Boolean).join("\n\n");

        for (const phrase of catchphrases) {
          const count = findOccurrences(corpus, phrase).length;
          if ((catchphraseReportMissing && count === 0) || count > catchphraseMaxCount) {
            findings.push({
              severity: "info",
              code: "STYLE_CATCHPHRASE_STATS",
              message: `角色口癖统计异常: ${character.id} "${phrase}" (count=${count})`,
              evidence: [{ file: character.path }],
              suggestedFix:
                count === 0
                  ? "考虑在相关章节加入该口癖，或更新角色卡 voice.catchphrases。"
                  : "考虑减少重复口癖或调整表达方式。",
            });
          }
        }
      }

      findings.sort(
        (a, b) =>
          a.severity.localeCompare(b.severity) ||
          a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message),
      );

      const repro = "/novel-style-check --scope=all";
      for (const finding of findings) {
        finding.repro = repro;
      }

      const warns = findings.filter((f) => f.severity === "warn").length;
      const infos = findings.filter((f) => f.severity === "info").length;

      const reportPathAbs = path.join(outputDir, "STYLE_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);
      if (writeReport) {
        writeTextFile(reportPathAbs, renderStyleReportMd({ findings, stats: { warns, infos } }), {
          mode: "if-changed",
        });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelStyleResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        stats: { warns, infos, durationMs },
        findings,
        nextSteps:
          warns > 0
            ? [
                "修复 STYLE_REPORT.md 中的问题后重新运行：/novel-style-check",
                "/novel-export（修复后导出）",
              ]
            : ["/novel-export（导出）"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [`warns: ${warns}`, `infos: ${infos}`, `durationMs: ${durationMs}`],
        resultJson,
        diagnostics,
      });
    },
  });
}

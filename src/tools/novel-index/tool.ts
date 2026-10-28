import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderIndexMd, renderThreadsReportMd, renderTimelineMd } from "./render";
import type { NovelIndexArgs, NovelIndexResultJson } from "./types";

type ThreadExtra = { opened_in?: string; expected_close_by?: string; closed_in?: string | null };

function resolveOutputDir(rootDir: string, outputDir: string): string {
  return path.isAbsolute(outputDir) ? outputDir : path.resolve(path.join(rootDir, outputDir));
}

function parseThreadExtras(
  rootDir: string,
  threadPath: string,
  diagnostics: Diagnostic[],
  encoding: NovelConfig["encoding"],
): ThreadExtra {
  const absolute = fromRelativePosixPath(rootDir, threadPath);
  if (!existsSync(absolute)) return {};
  const content = readTextFileSync(absolute, { encoding });
  const parsed = parseFrontmatter<Record<string, unknown>>(content, {
    file: threadPath,
    strict: false,
  });
  diagnostics.push(...parsed.diagnostics);

  const data = parsed.data;
  const opened =
    data.opened_in && typeof data.opened_in === "object"
      ? (data.opened_in as Record<string, unknown>).chapter_id
      : undefined;
  const opened_in = typeof opened === "string" ? opened : undefined;

  const expected_close_by =
    typeof data.expected_close_by === "string" ? data.expected_close_by : undefined;
  const closed_in =
    typeof data.closed_in === "string" || data.closed_in === null
      ? (data.closed_in as string | null)
      : undefined;

  return { opened_in, expected_close_by, closed_in };
}

export function createNovelIndexTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Generate derived INDEX/TIMELINE/THREADS_REPORT from manuscript snapshot (stable output).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      writeDerivedFiles: tool.schema.boolean().optional(),
      forceWrite: tool.schema.boolean().optional(),
      scanMode: tool.schema.enum(["full", "incremental"]).optional(),
      writeCache: tool.schema.boolean().optional(),
    },
    async execute(args: NovelIndexArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDir = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = resolveOutputDir(rootDir, args.outputDir ?? deps.config.index.outputDir);
      const writeDerivedFiles = args.writeDerivedFiles ?? deps.config.index.writeDerivedFiles;
      const forceWrite = args.forceWrite ?? false;
      const scanMode = args.scanMode ?? "incremental";
      const writeCache = args.writeCache ?? true;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir, mode: scanMode, writeCache },
      });
      diagnostics.push(...scan.diagnostics);

      const chaptersById = [...scan.entities.chapters].sort((a, b) =>
        a.chapter_id.localeCompare(b.chapter_id),
      );

      const characterStats = new Map<string, { count: number; first?: string; last?: string }>();
      for (const chapter of chaptersById) {
        for (const characterId of chapter.characters ?? []) {
          const current = characterStats.get(characterId) ?? { count: 0 };
          current.count += 1;
          if (!current.first) current.first = chapter.chapter_id;
          current.last = chapter.chapter_id;
          characterStats.set(characterId, current);
        }
      }

      const threadWithExtras = scan.entities.threads.map((t) => ({
        ...t,
        ...parseThreadExtras(rootDir, t.path, diagnostics, deps.config.encoding),
      }));

      // Cross-check thread status fields
      const chapterIdSet = new Set(chaptersById.map((c) => c.chapter_id));
      for (const t of threadWithExtras) {
        if (t.status === "closed" && !t.closed_in) {
          diagnostics.push({
            severity: "warn",
            code: "INDEX_THREAD_CLOSED_MISSING_CLOSED_IN",
            message: `线程 status=closed 但 closed_in 为空: ${t.thread_id}`,
            file: t.path,
          });
        }
        if (typeof t.closed_in === "string" && !chapterIdSet.has(t.closed_in)) {
          diagnostics.push({
            severity: deps.config.continuity.strictMode ? "error" : "warn",
            code: "INDEX_THREAD_CLOSED_IN_INVALID",
            message: `线程 closed_in 指向不存在章节: ${t.thread_id} -> ${t.closed_in}`,
            file: t.path,
          });
        }
      }

      // Timeline sorting: parse date/start when possible
      const chaptersForTimeline = [...chaptersById].sort((a, b) => {
        const aKey = `${a.timeline?.date ?? ""} ${a.timeline?.start ?? ""}`.trim();
        const bKey = `${b.timeline?.date ?? ""} ${b.timeline?.start ?? ""}`.trim();
        const aHas = aKey.length > 0;
        const bHas = bKey.length > 0;
        if (aHas && bHas) {
          const cmp = aKey.localeCompare(bKey);
          if (cmp !== 0) return cmp;
          return a.chapter_id.localeCompare(b.chapter_id);
        }
        if (aHas) return -1;
        if (bHas) return 1;
        return a.chapter_id.localeCompare(b.chapter_id);
      });

      const factionAppearances = new Map<string, { name?: string; count: number }>();
      const locationAppearances = new Map<string, { name?: string; count: number }>();

      for (const chapter of chaptersById) {
        const locationId = chapter.timeline?.location;
        if (locationId) {
          const current = locationAppearances.get(locationId) ?? { count: 0 };
          current.count += 1;
          locationAppearances.set(locationId, current);
        }
      }
      for (const loc of scan.entities.locations) {
        const current = locationAppearances.get(loc.id);
        if (current) {
          current.name = loc.name;
        } else {
          locationAppearances.set(loc.id, { name: loc.name, count: 0 });
        }
      }
      for (const fac of scan.entities.factions) {
        factionAppearances.set(fac.id, { name: fac.name, count: 0 });
      }

      const indexMd = renderIndexMd({
        chapters: chaptersById,
        characters: scan.entities.characters,
        threads: threadWithExtras,
        factions: [...factionAppearances.entries()]
          .map(([id, info]) => ({ id, name: info.name, appearances: info.count }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        locations: [...locationAppearances.entries()]
          .map(([id, info]) => ({ id, name: info.name, appearances: info.count }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        characterAppearances: characterStats,
      });

      const timelineMd = renderTimelineMd({ chapters: chaptersForTimeline });
      const threadsMd = renderThreadsReportMd({ threads: threadWithExtras });

      const writtenFiles: string[] = [];
      const skippedFiles: string[] = [];
      const outputs: Array<{ name: string; content: string }> = [
        { name: "INDEX.md", content: indexMd },
        { name: "TIMELINE.md", content: timelineMd },
        { name: "THREADS_REPORT.md", content: threadsMd },
      ];

      if (writeDerivedFiles) {
        for (const file of outputs) {
          const outPath = path.join(outputDir, file.name);
          const mode = forceWrite ? "always" : "if-changed";
          const { changed } = writeTextFile(outPath, file.content, { mode });
          const rel = toRelativePosixPath(rootDir, outPath);
          if (changed) writtenFiles.push(rel);
          else skippedFiles.push(rel);
        }
      }

      const durationMs = Date.now() - startedAt;
      const generatedAt = new Date().toISOString();
      const resultJson: NovelIndexResultJson = {
        version: 1,
        generatedAt,
        scanScope: {
          manuscriptDir,
          mode: scanMode,
        },
        outputDir: toRelativePosixPath(rootDir, outputDir),
        writtenFiles: writtenFiles.sort(),
        skippedFiles: skippedFiles.sort(),
        stats: {
          chapters: scan.entities.chapters.length,
          characters: scan.entities.characters.length,
          threads: scan.entities.threads.length,
          durationMs,
          scan: {
            filesScanned: scan.stats.filesScanned,
            durationMs: scan.stats.durationMs,
            cache: scan.stats.cache,
          },
        },
        nextSteps: [
          "/novel-continuity-check（时间线/引用一致性）",
          "/novel-foreshadowing-audit（伏笔/承诺对账）",
          "/novel-style-check（可选：风格一致性）",
          "/novel-export（导出）",
        ],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `generatedAt: ${generatedAt}`,
          `scanScope: manuscriptDir=${manuscriptDir}, mode=${scanMode}`,
          `outputDir: ${resultJson.outputDir}`,
          `writtenFiles: ${resultJson.writtenFiles.length}`,
          `skippedFiles: ${resultJson.skippedFiles.length}`,
          `scan: mode=${resultJson.stats.scan.cache.mode}, fastHits=${resultJson.stats.scan.cache.fastHits}, hashHits=${resultJson.stats.scan.cache.hashHits}, misses=${resultJson.stats.scan.cache.misses}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

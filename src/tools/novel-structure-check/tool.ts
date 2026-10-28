import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic, DiagnosticEvidence } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderStructureReportMd } from "./render";
import type {
  NovelStructureArgs,
  NovelStructureResultJson,
  NovelStructureScope,
  StructureFinding,
} from "./types";

type ScopedChapter = {
  chapter_id: string;
  path: string;
  structure?: { act?: number; beat_id?: string; beat_goal?: string };
};

function resolveScopeChapters(
  chapters: ScopedChapter[],
  scope?: NovelStructureScope,
): ScopedChapter[] {
  if (!scope || scope.kind === "all") return chapters;
  const found = chapters.find((chapter) => chapter.chapter_id === scope.chapter_id);
  return found ? [found] : [];
}

function normalizeBeatList(raw: string[]): string[] {
  const seen = new Set<string>();
  const beats: string[] = [];
  for (const beat of raw) {
    const normalized = beat.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    beats.push(normalized);
  }
  return beats;
}

function rankSeverity(value: StructureFinding["severity"]): number {
  if (value === "error") return 0;
  if (value === "warn") return 1;
  return 2;
}

function buildEvidence(file: string, excerpt?: string): DiagnosticEvidence {
  return { file, excerpt };
}

function countFindings(findings: StructureFinding[]): {
  errors: number;
  warns: number;
  infos: number;
} {
  let errors = 0;
  let warns = 0;
  let infos = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1;
    else if (finding.severity === "warn") warns += 1;
    else infos += 1;
  }
  return { errors, warns, infos };
}

export function createNovelStructureCheckTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Validate chapter structure beats (coverage, required beats, and beat ordering consistency).",
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
        ])
        .optional(),
      writeReport: tool.schema.boolean().optional(),
      requiredBeats: tool.schema.array(tool.schema.string()).optional(),
      minCoverage: tool.schema.number().min(0).max(1).optional(),
    },
    async execute(args: NovelStructureArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;
      const requiredBeats = normalizeBeatList(
        args.requiredBeats ?? deps.config.structure.required_beats ?? [],
      );
      const minCoverage = args.minCoverage ?? deps.config.structure.min_coverage ?? 0.8;

      if (requiredBeats.length === 0) {
        diagnostics.push({
          severity: "warn",
          code: "STR_REQUIRED_BEATS_EMPTY",
          message: "structure.required_beats 为空，无法执行节拍覆盖率校验。",
          suggestedFix:
            "在 .opencode/novel.jsonc 中配置 structure.required_beats，例如 setup/inciting_incident/midpoint/climax/resolution。",
        });
      }

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: {
          rootDir,
          manuscriptDir: manuscriptDirName,
          mode: "incremental",
          writeCache: true,
        },
      });
      diagnostics.push(...scan.diagnostics);

      const scopedChapters = resolveScopeChapters(scan.entities.chapters, args.scope);
      if (scopedChapters.length === 0) {
        diagnostics.push({
          severity: "warn",
          code: "STR_SCOPE_EMPTY",
          message: "scope 未匹配到任何章节。",
        });
      }

      const findings: StructureFinding[] = [];
      const requiredBeatSet = new Set(requiredBeats);
      const seenRequired = new Set<string>();
      const beatOrderIndex = new Map(requiredBeats.map((beat, index) => [beat, index] as const));

      const orderedBeatMentions: Array<{
        chapter_id: string;
        path: string;
        beat_id: string;
        beatIndex: number;
      }> = [];

      for (const chapter of scopedChapters) {
        const structure = chapter.structure;
        if (
          !structure ||
          (!structure.beat_id && structure.act === undefined && !structure.beat_goal)
        ) {
          findings.push({
            severity: "warn",
            code: "STR_CHAPTER_STRUCTURE_MISSING",
            message: `章节缺少 structure 信息: ${chapter.chapter_id}`,
            evidence: [buildEvidence(chapter.path)],
            suggestedFix:
              "在章节 frontmatter 中补充 structure.act / structure.beat_id / structure.beat_goal。",
          });
          continue;
        }

        const beatId = structure.beat_id?.trim();
        if (!beatId) continue;

        if (requiredBeatSet.has(beatId)) {
          seenRequired.add(beatId);
        }

        const beatIndex = beatOrderIndex.get(beatId);
        if (beatIndex !== undefined) {
          orderedBeatMentions.push({
            chapter_id: chapter.chapter_id,
            path: chapter.path,
            beat_id: beatId,
            beatIndex,
          });
        }
      }

      const missingBeats = requiredBeats.filter((beat) => !seenRequired.has(beat));
      for (const beat of missingBeats) {
        findings.push({
          severity: "warn",
          code: "STR_REQUIRED_BEAT_MISSING",
          message: `缺少关键节拍: ${beat}`,
          evidence: [buildEvidence(scopedChapters[0]?.path ?? "manuscript/chapters")],
          suggestedFix: `补充至少一章的 structure.beat_id=${beat}。`,
        });
      }

      let maxSeenIndex = -1;
      for (const mention of orderedBeatMentions) {
        if (mention.beatIndex < maxSeenIndex) {
          findings.push({
            severity: "warn",
            code: "STR_BEAT_ORDER_INVALID",
            message: `节拍顺序逆序: ${mention.chapter_id} 出现 ${mention.beat_id}`,
            evidence: [buildEvidence(mention.path)],
            suggestedFix:
              "按章节顺序重新安排 beat，确保 setup -> inciting_incident -> midpoint -> climax -> resolution。",
          });
        } else {
          maxSeenIndex = mention.beatIndex;
        }
      }

      const coverage =
        requiredBeats.length === 0
          ? 1
          : Number((seenRequired.size / requiredBeats.length).toFixed(4));
      if (requiredBeats.length > 0 && coverage < minCoverage) {
        findings.push({
          severity: "warn",
          code: "STR_COVERAGE_LOW",
          message: `关键节拍覆盖率过低: ${coverage} < ${minCoverage}`,
          evidence: [buildEvidence(scopedChapters[0]?.path ?? "manuscript/chapters")],
          suggestedFix: "补齐缺失节拍章节，或调低 structure.min_coverage（不建议低于 0.8）。",
        });
      }

      findings.sort(
        (a, b) =>
          rankSeverity(a.severity) - rankSeverity(b.severity) ||
          a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message),
      );

      const repro = "/novel-structure-check --scope=all";
      for (const finding of findings) {
        finding.repro = repro;
      }

      const findingStats = countFindings(findings);
      const reportPathAbs = path.join(outputDir, "STRUCTURE_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);

      if (writeReport) {
        writeTextFile(
          reportPathAbs,
          renderStructureReportMd({
            stats: {
              coverage,
              requiredBeats: requiredBeats.length,
              seenRequiredBeats: seenRequired.size,
              missing: missingBeats.length,
              orderErrors: findings.filter((f) => f.code === "STR_BEAT_ORDER_INVALID").length,
              errors: findingStats.errors,
              warns: findingStats.warns,
              infos: findingStats.infos,
            },
            findings,
          }),
          { mode: "if-changed" },
        );
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelStructureResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        stats: {
          coverage,
          requiredBeats: requiredBeats.length,
          seenRequiredBeats: seenRequired.size,
          missing: missingBeats.length,
          orderErrors: findings.filter((f) => f.code === "STR_BEAT_ORDER_INVALID").length,
          errors: findingStats.errors,
          warns: findingStats.warns,
          infos: findingStats.infos,
          durationMs,
        },
        findings,
        nextSteps:
          findingStats.errors + findingStats.warns > 0
            ? [
                "修复 STRUCTURE_REPORT.md 中的问题后重新运行：/novel-structure-check",
                "/novel-export --preflight=true（确认可导出）",
              ]
            : ["/novel-export --preflight=true（结构预检已通过）"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `coverage: ${coverage}`,
          `missing: ${missingBeats.length}`,
          `orderErrors: ${resultJson.stats.orderErrors}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

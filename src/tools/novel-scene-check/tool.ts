import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic, DiagnosticEvidence } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderSceneReportMd } from "./render";
import type { NovelSceneArgs, NovelSceneResultJson, NovelSceneScope, SceneFinding } from "./types";

type RequiredSceneField = "scene_id" | "objective" | "conflict" | "outcome" | "hook";

type ScopedChapter = {
  chapter_id: string;
  path: string;
  scenes?: Array<{
    scene_id?: string;
    objective?: string;
    conflict?: string;
    outcome?: string;
    hook?: string;
  }>;
};

function resolveScopeChapters(chapters: ScopedChapter[], scope?: NovelSceneScope): ScopedChapter[] {
  if (!scope || scope.kind === "all") return chapters;
  const found = chapters.find((chapter) => chapter.chapter_id === scope.chapter_id);
  return found ? [found] : [];
}

function buildEvidence(file: string, excerpt?: string): DiagnosticEvidence {
  return { file, excerpt };
}

function rankSeverity(value: SceneFinding["severity"]): number {
  if (value === "error") return 0;
  if (value === "warn") return 1;
  return 2;
}

function normalizeRequiredFields(fields: RequiredSceneField[]): RequiredSceneField[] {
  const seen = new Set<RequiredSceneField>();
  const normalized: RequiredSceneField[] = [];
  for (const field of fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    normalized.push(field);
  }
  return normalized;
}

function normalizeComparableText(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function countFindings(findings: SceneFinding[]): { errors: number; warns: number; infos: number } {
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

export function createNovelSceneCheckTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Validate scene-level writing flow fields (objective/conflict/outcome progression).",
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
      requiredFields: tool.schema
        .array(tool.schema.enum(["scene_id", "objective", "conflict", "outcome", "hook"]))
        .optional(),
    },
    async execute(args: NovelSceneArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;

      const requiredFields = normalizeRequiredFields(
        args.requiredFields ??
          (deps.config.scene.required_fields as RequiredSceneField[] | undefined) ?? [
            "scene_id",
            "objective",
            "conflict",
            "outcome",
          ],
      );

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
          code: "SCN_SCOPE_EMPTY",
          message: "scope 未匹配到任何章节。",
        });
      }

      const findings: SceneFinding[] = [];
      let sceneCount = 0;

      for (const chapter of scopedChapters) {
        const scenes = chapter.scenes ?? [];
        if (scenes.length === 0) {
          findings.push({
            severity: "warn",
            code: "SCN_CHAPTER_SCENES_MISSING",
            message: `章节缺少 scenes: ${chapter.chapter_id}`,
            evidence: [buildEvidence(chapter.path)],
            suggestedFix: "为章节补充 scenes 数组，至少包含 scene_id/objective/conflict/outcome。",
          });
          continue;
        }

        for (let index = 0; index < scenes.length; index += 1) {
          sceneCount += 1;
          const scene = scenes[index];
          const prefix = `${chapter.chapter_id} scenes[${index}]`;

          for (const field of requiredFields) {
            if (!scene[field]) {
              findings.push({
                severity: "warn",
                code: "SCN_REQUIRED_FIELD_MISSING",
                message: `${prefix} 缺少必填字段: ${field}`,
                evidence: [buildEvidence(chapter.path)],
                suggestedFix: `为 ${prefix} 补充 ${field}。`,
              });
            }
          }

          if (!scene.conflict) {
            findings.push({
              severity: "warn",
              code: "SCN_NO_CONFLICT",
              message: `${prefix} 缺少冲突（conflict）`,
              evidence: [buildEvidence(chapter.path)],
              suggestedFix: "补充角色阻力、外部阻碍或价值冲突，避免平推叙事。",
            });
          }

          const objectiveText = normalizeComparableText(scene.objective);
          const outcomeText = normalizeComparableText(scene.outcome);
          const noOutcome =
            !outcomeText ||
            outcomeText === objectiveText ||
            (objectiveText.length > 0 &&
              (outcomeText.includes(objectiveText) || objectiveText.includes(outcomeText)));
          if (noOutcome) {
            findings.push({
              severity: "warn",
              code: "SCN_NO_OUTCOME_CHANGE",
              message: `${prefix} 缺少有效推进结果（outcome）`,
              evidence: [buildEvidence(chapter.path)],
              suggestedFix: "确保 outcome 体现“状态变化”，而非重复 objective。",
            });
          }
        }
      }

      findings.sort(
        (a, b) =>
          rankSeverity(a.severity) - rankSeverity(b.severity) ||
          a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message),
      );
      const repro = "/novel-scene-check --scope=all";
      for (const finding of findings) {
        finding.repro = repro;
      }

      const findingStats = countFindings(findings);
      const invalidCount = findings.filter(
        (f) => f.severity === "error" || f.severity === "warn",
      ).length;
      const reportPathAbs = path.join(outputDir, "SCENE_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);

      if (writeReport) {
        writeTextFile(
          reportPathAbs,
          renderSceneReportMd({
            stats: {
              sceneCount,
              invalidCount,
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
      const resultJson: NovelSceneResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        stats: {
          sceneCount,
          invalidCount,
          errors: findingStats.errors,
          warns: findingStats.warns,
          infos: findingStats.infos,
          durationMs,
        },
        findings,
        nextSteps:
          invalidCount > 0
            ? [
                "修复 SCENE_REPORT.md 中的问题后重新运行：/novel-scene-check",
                "/novel-export --preflight=true（确认场景预检通过）",
              ]
            : ["/novel-export --preflight=true（场景预检已通过）"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `sceneCount: ${sceneCount}`,
          `invalidCount: ${invalidCount}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

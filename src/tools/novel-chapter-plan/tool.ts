import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import type {
  ChapterPlanJson,
  ChapterPlanScene,
  NovelChapterPlanArgs,
  NovelChapterPlanResultJson,
} from "./types";

function buildSceneBlueprint(options: {
  chapterId: string;
  sceneCount: number;
  structureRef?: string;
}): ChapterPlanScene[] {
  const templates: Array<{
    objective: string;
    conflict: string;
    outcome: string;
    hook?: string;
  }> = [
    {
      objective: "建立本章的直接目标，并与上章尾钩子对齐",
      conflict: "主角遭遇第一层阻力，暴露代价",
      outcome: "目标推进但出现不可忽视的新问题",
      hook: "抛出比开场更高风险的线索",
    },
    {
      objective: "推动计划进入执行阶段，迫使角色做选择",
      conflict: "外部压力与角色内在动机发生拉扯",
      outcome: "局势升级，主角付出明确代价",
      hook: "制造“必须立刻行动”的新时限",
    },
    {
      objective: "完成本章关键转折或反转",
      conflict: "核心对手或系统性阻力正面压制",
      outcome: "形成章节结论，同时把冲突递交到下一章",
      hook: "留下可追踪的新悬念",
    },
    {
      objective: "收束分支冲突，确认下一章主战场",
      conflict: "余波与后果清算",
      outcome: "完成本章闭环并切换到新任务",
      hook: "以高价值信息触发下一章开场",
    },
  ];

  return Array.from({ length: options.sceneCount }, (_, index) => {
    const template = templates[Math.min(index, templates.length - 1)];
    const sequence = index + 1;
    const sceneId = `${options.chapterId}-s${String(sequence).padStart(2, "0")}`;
    const beatTag = options.structureRef ? `（对齐 ${options.structureRef}）` : "";
    return {
      scene_id: sceneId,
      objective: `${template.objective}${beatTag}`,
      conflict: template.conflict,
      outcome: template.outcome,
      hook: template.hook,
    };
  });
}

function renderPlanMarkdown(plan: ChapterPlanJson): string {
  const lines: string[] = [
    "<!-- novel:derived v1; DO NOT EDIT BY HAND -->",
    "",
    `# ${plan.chapter_id} 章节计划`,
    "",
    "## Meta",
    "",
    `- chapter_id: ${plan.chapter_id}`,
    `- title: ${plan.title ?? "(unknown)"}`,
    `- structureRef: ${plan.structureRef ?? "(none)"}`,
    `- sourceChapterPath: ${plan.sourceChapterPath ?? "(not-found)"}`,
    "",
    "## Scene Blueprint",
    "",
    "| scene_id | objective | conflict | outcome | hook |",
    "|---|---|---|---|---|",
  ];

  for (const scene of plan.sceneBlueprint) {
    lines.push(
      `| ${scene.scene_id} | ${scene.objective} | ${scene.conflict} | ${scene.outcome} | ${scene.hook ?? ""} |`,
    );
  }

  lines.push("", "## Writing Checklist", "");
  for (const item of plan.writingChecklist) {
    lines.push(`- [ ] ${item}`);
  }

  lines.push("", "## Quality Gates", "");
  for (const gate of plan.qualityGates) {
    lines.push(`- ${gate}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function createNovelChapterPlanTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Generate chapter execution plan (scene blueprint + quality gates) for a target chapter.",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      chapter_id: tool.schema.string(),
      structureRef: tool.schema.string().optional(),
      outputPath: tool.schema.string().optional(),
      writeFile: tool.schema.boolean().optional(),
      sceneCount: tool.schema.number().int().positive().max(8).optional(),
    },
    async execute(args: NovelChapterPlanArgs) {
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const chapterId = args.chapter_id.trim();
      const writeFile = args.writeFile ?? true;
      const sceneCount = Math.max(1, Math.min(8, args.sceneCount ?? 3));

      if (!chapterId) {
        diagnostics.push({
          severity: "error",
          code: "PLAN_CHAPTER_ID_EMPTY",
          message: "chapter_id 不能为空。",
          suggestedFix: "传入章节 ID，例如 chapter_id=ch0001。",
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

      const chapter = scan.entities.chapters.find((item) => item.chapter_id === chapterId);
      if (!chapter) {
        diagnostics.push({
          severity: "warn",
          code: "PLAN_CHAPTER_NOT_FOUND",
          message: `未找到章节: ${chapterId}，将按模板生成计划草案。`,
          suggestedFix: "先创建章节文件并补齐 frontmatter，再重新生成计划。",
        });
      }

      const structureRef = args.structureRef?.trim()
        ? args.structureRef.trim()
        : chapter?.structure?.beat_id
          ? `beat:${chapter.structure.beat_id}`
          : chapter?.structure?.act
            ? `act:${chapter.structure.act}`
            : undefined;

      const planJson: ChapterPlanJson = {
        chapter_id: chapterId || "unknown",
        title: chapter?.title,
        structureRef,
        sourceChapterPath: chapter?.path,
        sceneBlueprint: buildSceneBlueprint({
          chapterId: chapterId || "unknown",
          sceneCount,
          structureRef,
        }),
        writingChecklist: [
          "开场 1 段内确认本章目标与风险",
          "每个 scene 都要有 objective/conflict/outcome",
          "本章至少推进 1 条主线程或关键伏笔",
          "章末保留可回收的下一章钩子",
        ],
        qualityGates: [
          "novel_scene_check 无 SCN_NO_OUTCOME_CHANGE",
          "novel_structure_check 关键节拍覆盖率达标",
          "novel_export preflight 不被阻断",
        ],
      };

      const outputPathAbs = path.isAbsolute(args.outputPath ?? "")
        ? (args.outputPath as string)
        : path.resolve(
            path.join(
              rootDir,
              args.outputPath ?? `${manuscriptDirName}/chapters/${chapterId}.plan.md`,
            ),
          );
      const outputPathRel = toRelativePosixPath(rootDir, outputPathAbs);

      if (chapter?.path) {
        const chapterAbs = path.resolve(path.join(rootDir, chapter.path));
        if (path.normalize(chapterAbs) === path.normalize(outputPathAbs)) {
          diagnostics.push({
            severity: "error",
            code: "PLAN_OUTPUT_OVERWRITE_CHAPTER",
            message: "计划输出路径不能覆盖章节正文文件。",
            suggestedFix: "使用默认 *.plan.md 或传入新的 outputPath。",
          });
        }
      }

      const hasBlockingError = diagnostics.some((item) => item.severity === "error");
      if (writeFile && !hasBlockingError) {
        writeTextFile(outputPathAbs, renderPlanMarkdown(planJson), { mode: "if-changed" });
      }

      const resultJson: NovelChapterPlanResultJson = {
        version: 1,
        planPath: writeFile && !hasBlockingError ? outputPathRel : undefined,
        planJson,
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `chapter_id: ${planJson.chapter_id}`,
          `sceneCount: ${planJson.sceneBlueprint.length}`,
          `planPath: ${resultJson.planPath ?? "(dry-run/blocked)"}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

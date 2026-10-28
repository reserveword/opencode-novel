import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import type {
  NovelOutlineArgs,
  NovelOutlineMode,
  NovelOutlineResultJson,
  OutlineAct,
  OutlineBeat,
  OutlineJson,
} from "./types";

function normalizeBeats(raw: string[]): string[] {
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

function buildBeatLabel(beatId: string): string {
  return beatId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function createBeat(beatId: string, index: number, total: number): OutlineBeat {
  const ratio = total <= 1 ? 1 : index / (total - 1);
  const spanStart = Math.floor(ratio * 80) + 1;
  const spanEnd = Math.min(100, spanStart + 15);
  return {
    beat_id: beatId,
    label: buildBeatLabel(beatId),
    goal: `围绕 ${buildBeatLabel(beatId)} 推进主线冲突`,
    risk: "避免信息堆砌，确保角色选择带来代价",
    expectedChapterSpan: `${spanStart}%~${spanEnd}%`,
  };
}

function buildThreeActOutline(options: {
  title: string;
  acts: number;
  requiredBeats: string[];
}): OutlineJson {
  const actCount = Math.max(1, options.acts);
  const beats = options.requiredBeats;
  const actBuckets: OutlineAct[] = Array.from({ length: actCount }, (_, idx) => ({
    act: idx + 1,
    purpose:
      idx === 0
        ? "建立主角、欲望与初始困局"
        : idx === actCount - 1
          ? "冲突决断与结局回收"
          : "冲突升级、代价累积与策略修正",
    conflictUpgrade:
      idx === 0
        ? "从静态世界推进到不可回头的事件"
        : idx === actCount - 1
          ? "把隐性矛盾转化为正面决战"
          : "通过失败和反噬提高风险阈值",
    beats: [],
  }));

  if (beats.length === 0) {
    actBuckets[0].beats.push(createBeat("setup", 0, 1));
  } else {
    beats.forEach((beatId, index) => {
      const bucketIndex = Math.min(
        actCount - 1,
        Math.floor((index * actCount) / Math.max(1, beats.length)),
      );
      actBuckets[bucketIndex].beats.push(createBeat(beatId, index, beats.length));
    });
  }

  return {
    title: options.title,
    mode: "three_act",
    generatedAt: new Date().toISOString(),
    requiredBeats: [...beats],
    acts: actBuckets,
    processChecklist: [
      "每章必须标注 structure.act / structure.beat_id / structure.beat_goal",
      "每个 scene 至少包含 objective/conflict/outcome",
      "关键节拍覆盖率默认不得低于 0.8",
      "导出前必须通过 structure + arc + pacing 预检",
    ],
  };
}

function buildBeatSheetOutline(options: { title: string; requiredBeats: string[] }): OutlineJson {
  const beats = options.requiredBeats.length > 0 ? options.requiredBeats : ["setup", "climax"];
  return {
    title: options.title,
    mode: "beat_sheet",
    generatedAt: new Date().toISOString(),
    requiredBeats: [...beats],
    acts: [
      {
        act: 1,
        purpose: "按节拍单逐项推进冲突，不允许空节拍",
        conflictUpgrade: "每个 beat 都必须带来状态变化",
        beats: beats.map((beatId, index) => createBeat(beatId, index, beats.length)),
      },
    ],
    processChecklist: [
      "节拍表先于章节草稿，先验收节拍再写正文",
      "每个 beat 显式绑定至少 1 个 scene",
      "连续两个 beat 不得重复同一冲突结果",
      "关键节拍必须可追踪到章节 ID",
    ],
  };
}

function buildOutline(options: {
  title: string;
  mode: NovelOutlineMode;
  acts: number;
  requiredBeats: string[];
}): OutlineJson {
  if (options.mode === "beat_sheet") {
    return buildBeatSheetOutline({ title: options.title, requiredBeats: options.requiredBeats });
  }
  return buildThreeActOutline({
    title: options.title,
    acts: options.acts,
    requiredBeats: options.requiredBeats,
  });
}

export function createNovelOutlineTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description: "Generate a structured novel outline (three-act or beat-sheet) as typed JSON.",
    args: {
      rootDir: tool.schema.string().optional(),
      title: tool.schema.string(),
      mode: tool.schema.enum(["three_act", "beat_sheet"]).optional(),
      acts: tool.schema.number().int().positive().max(8).optional(),
      outputPath: tool.schema.string().optional(),
      writeFile: tool.schema.boolean().optional(),
    },
    async execute(args: NovelOutlineArgs) {
      const diagnostics: Diagnostic[] = [];
      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const title = args.title.trim();
      const mode: NovelOutlineMode = args.mode ?? "three_act";
      const acts = args.acts ?? 3;
      const writeFile = args.writeFile ?? true;
      const requiredBeats = normalizeBeats(deps.config.structure.required_beats ?? []);

      if (!title) {
        diagnostics.push({
          severity: "error",
          code: "OUTLINE_TITLE_EMPTY",
          message: "title 不能为空。",
          suggestedFix: '传入明确书名，例如 title="长夜行者"。',
        });
      }

      const outlineJson = buildOutline({
        title: title || "Untitled",
        mode,
        acts,
        requiredBeats,
      });

      const outputPathAbs = path.isAbsolute(args.outputPath ?? "")
        ? (args.outputPath as string)
        : path.resolve(
            path.join(
              rootDir,
              args.outputPath ?? path.join(deps.config.index.outputDir, `OUTLINE.${mode}.json`),
            ),
          );
      const outputPathRel = toRelativePosixPath(rootDir, outputPathAbs);

      if (writeFile) {
        writeTextFile(outputPathAbs, `${JSON.stringify(outlineJson, null, 2)}\n`, {
          mode: "if-changed",
        });
      }

      const resultJson: NovelOutlineResultJson = {
        version: 1,
        outlinePath: writeFile ? outputPathRel : undefined,
        outlineJson,
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `mode: ${mode}`,
          `acts: ${outlineJson.acts.length}`,
          `beats: ${outlineJson.acts.reduce((sum, act) => sum + act.beats.length, 0)}`,
          `outlinePath: ${writeFile ? outputPathRel : "(dry-run)"}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

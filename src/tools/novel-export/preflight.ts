import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import type { ToolContext } from "../../shared/plugin/tool";
import type { NovelContinuityResultJson } from "../novel-continuity-check";
import { createNovelContinuityCheckTool } from "../novel-continuity-check";
import type { NovelForeshadowingResultJson } from "../novel-foreshadowing-audit";
import { createNovelForeshadowingAuditTool } from "../novel-foreshadowing-audit";
import type { NovelIndexResultJson } from "../novel-index";
import { createNovelIndexTool } from "../novel-index";
import type { NovelSceneResultJson } from "../novel-scene-check";
import { createNovelSceneCheckTool } from "../novel-scene-check";
import type { NovelStructureResultJson } from "../novel-structure-check";
import { createNovelStructureCheckTool } from "../novel-structure-check";
import type { NovelStyleResultJson } from "../novel-style-check";
import { createNovelStyleCheckTool } from "../novel-style-check";
import type {
  NovelExportPreflightCheck,
  NovelExportPreflightFailOn,
  NovelExportPreflightSummary,
} from "./types";

/** 创建本地预检执行所需的最小工具上下文（无代理运行时）。 */
function createFallbackToolContext(_directory: string): ToolContext {
  return {
    sessionID: "local",
    messageID: "local",
    id: "local",
    agent: "novel_export",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

/** 从标准 Markdown 工具输出中提取 JSON 结果块。 */
function extractResultJson(markdownOutput: string): unknown {
  const match = markdownOutput.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error("No ```json block found in tool output");
  }
  return JSON.parse(match[1]);
}

/** 按严重级别统计诊断数量。 */
function countDiagnostics(diagnostics: Diagnostic[]): {
  errors: number;
  warns: number;
  infos: number;
} {
  let errors = 0;
  let warns = 0;
  let infos = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warn") warns += 1;
    else infos += 1;
  }
  return { errors, warns, infos };
}

/** 根据 failOn 策略判断预检是否应阻断导出。 */
function shouldBlockPreflight(
  stats: { errors: number; warns: number },
  failOn: NovelExportPreflightFailOn,
): boolean {
  if (failOn === "warn") return stats.errors + stats.warns > 0;
  return stats.errors > 0;
}

export type RunPreflightOptions = {
  projectRoot: string;
  config: NovelConfig;
  rootDir: string;
  manuscriptDir: string;
  enabled: boolean;
  checks: NovelExportPreflightCheck[];
  failOn: NovelExportPreflightFailOn;
  context?: ToolContext;
};

/** 执行配置的预检项并汇总检查报告。 */
export async function runPreflight(
  options: RunPreflightOptions,
): Promise<{ summary: NovelExportPreflightSummary | undefined; diagnostics: Diagnostic[] }> {
  if (!options.enabled) return { summary: undefined, diagnostics: [] };

  const ctx = options.context ?? createFallbackToolContext(options.rootDir);
  const outputDir = options.config.index.outputDir;
  const diagnostics: Diagnostic[] = [];

  const stats = { errors: 0, warns: 0, infos: 0 };
  const reports: NovelExportPreflightSummary["reports"] = {};
  let blocked = false;

  const checks = Array.from(new Set(options.checks));

  const suggestedFixByCheck: Record<NovelExportPreflightCheck, string> = {
    index:
      "请先运行 /novel-index，确认能正常生成 INDEX/TIMELINE/THREADS_REPORT 后再重试 /novel-export。",
    continuity:
      "请先运行 /novel-continuity-check，修复 CONTINUITY_REPORT.md 中的问题后再重试 /novel-export。",
    foreshadowing:
      "请先运行 /novel-foreshadowing-audit，修复 FORESHADOWING_AUDIT.md 中的问题后再重试 /novel-export。",
    style: "请先运行 /novel-style-check，修复 STYLE_REPORT.md 中的问题后再重试 /novel-export。",
    structure:
      "请先运行 /novel-structure-check，修复 STRUCTURE_REPORT.md 中的问题后再重试 /novel-export。",
    scene: "请先运行 /novel-scene-check，修复 SCENE_REPORT.md 中的问题后再重试 /novel-export。",
    arc: "请先运行 /novel-continuity-check，修复角色弧光与因果链断裂问题后再重试 /novel-export。",
    pacing: "请先运行 /novel-style-check，修复节奏与对话占比问题后再重试 /novel-export。",
  };

  const guard = async (check: NovelExportPreflightCheck, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors += 1;
      blocked = true;
      diagnostics.push({
        severity: "error",
        code: "EXPORT_PREFLIGHT_CHECK_FAILED",
        message: `预检步骤执行失败: ${check} (${message})`,
        suggestedFix: suggestedFixByCheck[check],
      });
    }
  };

  let continuityCombined:
    | {
        errors: number;
        warns: number;
        infos: number;
        reportPath?: string;
        diagnostics: Diagnostic[];
      }
    | undefined;
  let continuityCounted = false;

  const runContinuityOnce = async () => {
    if (continuityCombined) return continuityCombined;
    const toolDef = createNovelContinuityCheckTool({
      projectRoot: options.projectRoot,
      config: options.config,
    });
    const out = await toolDef.execute(
      {
        rootDir: options.rootDir,
        manuscriptDir: options.manuscriptDir,
        outputDir,
        scope: { kind: "all" },
        writeReport: true,
      },
      ctx,
    );
    const json = extractResultJson(String(out)) as NovelContinuityResultJson;
    const diagStats = countDiagnostics(json.diagnostics);
    continuityCombined = {
      errors: json.stats.errors + diagStats.errors,
      warns: json.stats.warns + diagStats.warns,
      infos: json.stats.infos + diagStats.infos,
      reportPath: json.reportPath,
      diagnostics: json.diagnostics,
    };
    return continuityCombined;
  };

  let styleCombined:
    | {
        errors: number;
        warns: number;
        infos: number;
        reportPath?: string;
        diagnostics: Diagnostic[];
      }
    | undefined;
  let styleCounted = false;

  const runStyleOnce = async () => {
    if (styleCombined) return styleCombined;
    const toolDef = createNovelStyleCheckTool({
      projectRoot: options.projectRoot,
      config: options.config,
    });
    const out = await toolDef.execute(
      {
        rootDir: options.rootDir,
        manuscriptDir: options.manuscriptDir,
        outputDir,
        scope: { kind: "all" },
        writeReport: true,
      },
      ctx,
    );
    const json = extractResultJson(String(out)) as NovelStyleResultJson;
    const diagStats = countDiagnostics(json.diagnostics);
    styleCombined = {
      errors: diagStats.errors,
      warns: json.stats.warns + diagStats.warns,
      infos: json.stats.infos + diagStats.infos,
      reportPath: json.reportPath,
      diagnostics: json.diagnostics,
    };
    return styleCombined;
  };

  if (checks.includes("index")) {
    await guard("index", async () => {
      const toolDef = createNovelIndexTool({
        projectRoot: options.projectRoot,
        config: options.config,
      });
      const out = await toolDef.execute(
        {
          rootDir: options.rootDir,
          manuscriptDir: options.manuscriptDir,
          outputDir,
          writeDerivedFiles: true,
        },
        ctx,
      );
      const json = extractResultJson(String(out)) as NovelIndexResultJson;
      const diagStats = countDiagnostics(json.diagnostics);
      stats.errors += diagStats.errors;
      stats.warns += diagStats.warns;
      stats.infos += diagStats.infos;
      reports.indexOutputDir = json.outputDir;
      diagnostics.push(...json.diagnostics);
      blocked ||= shouldBlockPreflight(diagStats, options.failOn);
    });
  }

  if (checks.includes("continuity")) {
    await guard("continuity", async () => {
      const combined = await runContinuityOnce();
      if (!continuityCounted) {
        stats.errors += combined.errors;
        stats.warns += combined.warns;
        stats.infos += combined.infos;
        diagnostics.push(...combined.diagnostics);
        continuityCounted = true;
      }
      reports.continuityReportPath = combined.reportPath;
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("foreshadowing")) {
    await guard("foreshadowing", async () => {
      const toolDef = createNovelForeshadowingAuditTool({
        projectRoot: options.projectRoot,
        config: options.config,
      });
      const out = await toolDef.execute(
        {
          rootDir: options.rootDir,
          manuscriptDir: options.manuscriptDir,
          outputDir,
          writeReport: true,
        },
        ctx,
      );
      const json = extractResultJson(String(out)) as NovelForeshadowingResultJson;
      const diagStats = countDiagnostics(json.diagnostics);

      let issueErrors = 0;
      let issueWarns = 0;
      let issueInfos = 0;
      for (const item of json.items) {
        for (const issue of item.issues) {
          if (issue.severity === "error") issueErrors += 1;
          else if (issue.severity === "warn") issueWarns += 1;
          else issueInfos += 1;
        }
      }

      const combined = {
        errors: issueErrors + diagStats.errors,
        warns: issueWarns + diagStats.warns,
        infos: issueInfos + diagStats.infos,
      };
      stats.errors += combined.errors;
      stats.warns += combined.warns;
      stats.infos += combined.infos;
      reports.foreshadowingReportPath = json.reportPath;
      diagnostics.push(...json.diagnostics);
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("style")) {
    await guard("style", async () => {
      const combined = await runStyleOnce();
      if (!styleCounted) {
        stats.errors += combined.errors;
        stats.warns += combined.warns;
        stats.infos += combined.infos;
        diagnostics.push(...combined.diagnostics);
        styleCounted = true;
      }
      reports.styleReportPath = combined.reportPath;
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("structure")) {
    await guard("structure", async () => {
      const toolDef = createNovelStructureCheckTool({
        projectRoot: options.projectRoot,
        config: options.config,
      });
      const out = await toolDef.execute(
        {
          rootDir: options.rootDir,
          manuscriptDir: options.manuscriptDir,
          outputDir,
          scope: { kind: "all" },
          writeReport: true,
        },
        ctx,
      );
      const json = extractResultJson(String(out)) as NovelStructureResultJson;
      const diagStats = countDiagnostics(json.diagnostics);
      const combined = {
        errors: json.stats.errors + diagStats.errors,
        warns: json.stats.warns + diagStats.warns,
        infos: json.stats.infos + diagStats.infos,
      };
      stats.errors += combined.errors;
      stats.warns += combined.warns;
      stats.infos += combined.infos;
      reports.structureReportPath = json.reportPath;
      diagnostics.push(...json.diagnostics);
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("scene")) {
    await guard("scene", async () => {
      const toolDef = createNovelSceneCheckTool({
        projectRoot: options.projectRoot,
        config: options.config,
      });
      const out = await toolDef.execute(
        {
          rootDir: options.rootDir,
          manuscriptDir: options.manuscriptDir,
          outputDir,
          scope: { kind: "all" },
          writeReport: true,
        },
        ctx,
      );
      const json = extractResultJson(String(out)) as NovelSceneResultJson;
      const diagStats = countDiagnostics(json.diagnostics);
      const combined = {
        errors: json.stats.errors + diagStats.errors,
        warns: json.stats.warns + diagStats.warns,
        infos: json.stats.infos + diagStats.infos,
      };
      stats.errors += combined.errors;
      stats.warns += combined.warns;
      stats.infos += combined.infos;
      reports.sceneReportPath = json.reportPath;
      diagnostics.push(...json.diagnostics);
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("arc")) {
    await guard("arc", async () => {
      const combined = await runContinuityOnce();
      if (!continuityCounted) {
        stats.errors += combined.errors;
        stats.warns += combined.warns;
        stats.infos += combined.infos;
        diagnostics.push(...combined.diagnostics);
        continuityCounted = true;
      }
      reports.arcReportPath = combined.reportPath;
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  if (checks.includes("pacing")) {
    await guard("pacing", async () => {
      const combined = await runStyleOnce();
      if (!styleCounted) {
        stats.errors += combined.errors;
        stats.warns += combined.warns;
        stats.infos += combined.infos;
        diagnostics.push(...combined.diagnostics);
        styleCounted = true;
      }
      reports.pacingReportPath = combined.reportPath;
      blocked ||= shouldBlockPreflight(combined, options.failOn);
    });
  }

  const summary: NovelExportPreflightSummary = {
    enabled: true,
    blocked,
    checks,
    failOn: options.failOn,
    stats,
    reports,
  };

  if (blocked) {
    diagnostics.push({
      severity: "error",
      code: "EXPORT_PREFLIGHT_BLOCKED",
      message: `预检未通过（failOn=${options.failOn}）。请先修复报告中的问题后再导出。`,
      suggestedFix:
        "建议依次运行：/novel-index、/novel-structure-check、/novel-scene-check、/novel-continuity-check、/novel-foreshadowing-audit（以及 /novel-style-check），修复后重新 /novel-export。",
    });
  }

  return { summary, diagnostics };
}

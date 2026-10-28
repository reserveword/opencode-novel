import path from "node:path";
import { type ConfigLoadError, loadNovelConfig } from "../../config/load";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import type { NovelConfigCheckArgs, NovelConfigCheckResultJson } from "./types";

function toDiagnostic(rootDir: string, error: ConfigLoadError): Diagnostic {
  const severity: Diagnostic["severity"] = error.source === "defaults" ? "error" : "warn";
  return {
    severity,
    code: "CONFIG_LOAD_ERROR",
    message: `[${error.source}] ${error.message}`,
    file: error.path ? toRelativePosixPath(rootDir, error.path) : undefined,
    suggestedFix:
      error.source === "project"
        ? "请修复项目配置 .opencode/novel.jsonc 后重试。"
        : error.source === "user"
          ? "请修复用户级配置 ~/.config/opencode/novel.jsonc（或 Windows 对应路径）后重试。"
          : "请检查默认配置合并与 schema 约束。",
    repro: "/novel-config-check",
  };
}

export function createNovelConfigCheckTool(deps: { projectRoot: string }): ToolDefinition {
  return tool({
    description:
      "Validate merged novel config sources and return structured diagnostics with source/path.",
    args: {
      rootDir: tool.schema.string().optional(),
    },
    async execute(args: NovelConfigCheckArgs) {
      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const loaded = loadNovelConfig(rootDir);

      const diagnostics = loaded.errors.map((error) => toDiagnostic(rootDir, error));
      const resultJson: NovelConfigCheckResultJson = {
        version: 1,
        valid: diagnostics.length === 0,
        projectRoot: rootDir,
        sources: loaded.sources,
        nextSteps:
          diagnostics.length > 0
            ? ["修复配置错误后重试：/novel-config-check", "/novel-index（配置通过后执行）"]
            : ["/novel-index", "/novel-export --preflight"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `valid: ${resultJson.valid}`,
          `errors: ${diagnostics.filter((d) => d.severity === "error").length}`,
          `warns: ${diagnostics.filter((d) => d.severity === "warn").length}`,
          `projectSource: ${loaded.sources.project ?? "(none)"}`,
          `userSource: ${loaded.sources.user ?? "(none)"}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

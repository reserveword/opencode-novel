import { resolve } from "node:path";
import type { NovelConfig } from "../../config/schema";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { ensureNovelScaffold } from "./scaffold";
import type { NovelScaffoldArgs, NovelScaffoldResultJson } from "./types";

export function createNovelScaffoldTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Create/repair novel manuscript skeleton and derived directories deterministically (no LLM).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      bookTitle: tool.schema.string().optional(),
      writeConfigJsonc: tool.schema.boolean().optional(),
      writeTemplates: tool.schema.boolean().optional(),
      forceOverwriteTemplates: tool.schema.boolean().optional(),
    },
    async execute(rawArgs: NovelScaffoldArgs) {
      const startedAt = Date.now();
      const rootDir = resolve(rawArgs.rootDir ?? deps.projectRoot);
      const manuscriptDirName = rawArgs.manuscriptDir ?? deps.config.manuscriptDir ?? "manuscript";

      const scaffold = ensureNovelScaffold({
        rootDir,
        manuscriptDirName,
        config: deps.config,
        bookTitle: rawArgs.bookTitle,
        writeConfigJsonc: rawArgs.writeConfigJsonc ?? true,
        writeTemplates: rawArgs.writeTemplates ?? true,
        forceOverwriteTemplates: rawArgs.forceOverwriteTemplates ?? false,
      });

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelScaffoldResultJson = {
        version: 1,
        manuscriptDir: scaffold.manuscriptDir,
        createdDirs: scaffold.createdDirs,
        writtenFiles: scaffold.writtenFiles,
        skippedExisting: scaffold.skippedExisting,
        configPath: scaffold.configPath,
        nextSteps: [
          "/novel-index（生成 INDEX/TIMELINE/THREADS_REPORT）",
          "/novel-import --from=<path>（可选：迁移旧稿）",
          "/novel-chapter-plan ch0001（开始写第 1 章）",
        ],
        diagnostics: scaffold.diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `createdDirs: ${scaffold.createdDirs.length}`,
          `writtenFiles: ${scaffold.writtenFiles.length}`,
          `skippedExisting: ${scaffold.skippedExisting.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson: resultJson,
        diagnostics: scaffold.diagnostics,
      });
    },
  });
}

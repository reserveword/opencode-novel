import type { NovelConfig } from "../../config/schema";
import { sortDiagnostics } from "../../shared/errors/diagnostics";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { scanNovelProject } from "./scan";
import type { NovelScanArgs, NovelScanResultJson } from "./types";

export function createNovelScanTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Scan novel project, parse manuscript frontmatter, and build a stable snapshot for indexing/auditing/export.",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      mode: tool.schema.enum(["full", "incremental"]).optional(),
      strictMode: tool.schema.boolean().optional(),
      writeCache: tool.schema.boolean().optional(),
    },
    async execute(args: NovelScanArgs) {
      const { result } = scanNovelProject({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args,
      });
      const final: NovelScanResultJson = {
        ...result,
        diagnostics: sortDiagnostics(result.diagnostics),
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `filesScanned: ${final.stats.filesScanned}`,
          `entities: chapters=${final.stats.entities.chapters}, characters=${final.stats.entities.characters}, threads=${final.stats.entities.threads}`,
          `cache: mode=${final.stats.cache.mode}, fastHits=${final.stats.cache.fastHits}, hashHits=${final.stats.cache.hashHits}, misses=${final.stats.cache.misses}`,
          `durationMs: ${final.stats.durationMs}`,
        ],
        resultJson: final,
        diagnostics: final.diagnostics,
      });
    },
  });
}

import { Plugin } from "@opencode/plugin";
import { loadNovelConfig } from "./config/load";
import { registerNovelAgents } from "./plugin-handlers";
import type { ToolDefinition } from "./shared/plugin/tool";
import { createNovelApplyCandidatesTool } from "./tools/novel-apply-candidates";
import { createNovelBibleTool } from "./tools/novel-bible";
import { createNovelBootstrapTool } from "./tools/novel-bootstrap";
import { createNovelCandidatesWriteTool } from "./tools/novel-candidates-write";
import { createNovelChapterPlanTool } from "./tools/novel-chapter-plan";
import { createNovelCharacterReportTool } from "./tools/novel-character-report";
import { createNovelConfigCheckTool } from "./tools/novel-config-check";
import { createNovelContextPackTool } from "./tools/novel-context-pack";
import { createNovelContinuityCheckTool } from "./tools/novel-continuity-check";
import { createNovelEntityGapsTool } from "./tools/novel-entity-gaps";
import { createNovelExportTool } from "./tools/novel-export";
import { createNovelForeshadowingAuditTool } from "./tools/novel-foreshadowing-audit";
import { createNovelGraphTool } from "./tools/novel-graph";
import { createNovelImportTool } from "./tools/novel-import";
import { createNovelIndexTool } from "./tools/novel-index";
import { createNovelOutlineTool } from "./tools/novel-outline";
import { createNovelScaffoldTool } from "./tools/novel-scaffold";
import { createNovelScanTool } from "./tools/novel-scan";
import { createNovelSceneCheckTool } from "./tools/novel-scene-check";
import { createNovelSetupTool } from "./tools/novel-setup";
import { createNovelSnapshotTool } from "./tools/novel-snapshot";
import { createNovelStructureCheckTool } from "./tools/novel-structure-check";
import { createNovelStyleCheckTool } from "./tools/novel-style-check";
import { createSkillTool } from "./tools/skill";
import { createSlashcommandTool } from "./tools/slashcommand";

type OpenCodePluginContext = Parameters<Plugin.Plugin["setup"]>[0];
type ToolEditor = Parameters<OpenCodePluginContext["tool"]["transform"]>[0] extends (
  editor: infer Editor,
) => unknown
  ? Editor
  : never;
type ToolRegistration = Parameters<ToolEditor["add"]>[0];

/**
 * Register plugin tools with the OpenCode 2.x tool transform.
 *
 * OpenCode 2.x expects a JSON Schema `input` plus a structured result, while the
 * plugin internals still model tools as `{ description, input, execute }`.
 */
async function registerTools(
  ctx: OpenCodePluginContext,
  definitions: Record<string, ToolDefinition>,
): Promise<void> {
  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(definitions)) {
      const registration = {
        name,
        description: definition.description,
        input: definition.input,
        execute: async (input: unknown, context: Parameters<ToolDefinition["execute"]>[1]) => ({
          content: await definition.execute(input as Record<string, unknown>, context),
        }),
      } satisfies Record<string, unknown>;

      editor.add(registration as unknown as ToolRegistration);
    }
  });
}

/**
 * OpenCode 2.x plugin entrypoint.
 *
 * The default export must be the result of `Plugin.define`; OpenCode treats it
 * as the plugin instance and calls `setup` once per loaded location.
 */
export default Plugin.define({
  id: "opencode-novel",
  /** Load `novel.jsonc`, then register the novel tools and agents. */
  async setup(ctx) {
    const projectRoot = ctx.location.directory;
    const { config, errors } = loadNovelConfig(projectRoot);
    for (const error of errors) {
      const location = error.path ? ` (${error.path})` : "";
      console.warn(`[opencode-novel] config error [${error.source}]${location}: ${error.message}`);
    }

    const tools: Record<string, ToolDefinition> = {
      novel_setup: createNovelSetupTool({ projectRoot, config }),
      novel_bootstrap: createNovelBootstrapTool({ projectRoot, config }),
      novel_scan: createNovelScanTool({ projectRoot, config }),
      novel_scaffold: createNovelScaffoldTool({ projectRoot, config }),
      novel_index: createNovelIndexTool({ projectRoot, config }),
      novel_import: createNovelImportTool({ projectRoot, config }),
      novel_bible: createNovelBibleTool({ projectRoot, config }),
      novel_entity_gaps: createNovelEntityGapsTool({ projectRoot, config }),
      novel_graph: createNovelGraphTool({ projectRoot, config }),
      novel_character_report: createNovelCharacterReportTool({ projectRoot, config }),
      novel_config_check: createNovelConfigCheckTool({ projectRoot }),
      novel_context_pack: createNovelContextPackTool({ projectRoot, config }),
      novel_export: createNovelExportTool({ projectRoot, config }),
      novel_style_check: createNovelStyleCheckTool({ projectRoot, config }),
      novel_foreshadowing_audit: createNovelForeshadowingAuditTool({ projectRoot, config }),
      novel_apply_candidates: createNovelApplyCandidatesTool({ projectRoot, config }),
      novel_candidates_write: createNovelCandidatesWriteTool({ projectRoot, config }),
      novel_continuity_check: createNovelContinuityCheckTool({ projectRoot, config }),
      novel_structure_check: createNovelStructureCheckTool({ projectRoot, config }),
      novel_scene_check: createNovelSceneCheckTool({ projectRoot, config }),
      novel_outline: createNovelOutlineTool({ projectRoot, config }),
      novel_chapter_plan: createNovelChapterPlanTool({ projectRoot, config }),
      novel_snapshot: createNovelSnapshotTool({ projectRoot, config }),
    };

    const compat = config.compat;
    if (compat.export_skill_tool) {
      tools.skill = createSkillTool({
        projectRoot,
        disabledSkills: config.disabled_skills,
      });
    }
    if (compat.export_slashcommand_tool) {
      tools.slashcommand = createSlashcommandTool({
        projectRoot,
        disabledCommands: config.disabled_commands,
        disabledSkills: config.disabled_skills,
      });
    }

    await registerTools(ctx, tools);
    await registerNovelAgents(ctx, config);
  },
});

// NOTE: Do NOT export runtime functions from main index.ts!
// OpenCode loads this module's default export as the plugin definition.

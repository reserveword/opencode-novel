import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { sortDiagnostics } from "../../shared/errors/diagnostics";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { createNovelCharacterReportTool } from "../novel-character-report";
import { createNovelEntityGapsTool } from "../novel-entity-gaps";
import { createNovelGraphTool } from "../novel-graph";
import { createNovelImportTool } from "../novel-import";
import { createNovelIndexTool } from "../novel-index";
import { createNovelScaffoldTool } from "../novel-scaffold";
import type { NovelBootstrapArgs, NovelBootstrapResultJson } from "./types";

function resolveMaybeRelative(rootDir: string, maybePath: string): string {
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.resolve(path.join(rootDir, maybePath));
}

function extractResultJson(markdownOutput: string): unknown {
  const match = markdownOutput.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error("No ```json block found in tool output");
  }
  return JSON.parse(match[1]);
}

async function executeToolDef(
  toolDef: ToolDefinition,
  args: Record<string, unknown>,
): Promise<string> {
  const executable = toolDef as unknown as {
    execute: (toolArgs: Record<string, unknown>) => unknown | Promise<unknown>;
  };
  const out = await executable.execute(args);
  return String(out);
}

function pushStepDiagnostics(diagnostics: Diagnostic[], stepName: string, output: unknown) {
  if (!output || typeof output !== "object") return;
  const maybe = output as { diagnostics?: unknown };
  if (!Array.isArray(maybe.diagnostics)) return;
  for (const d of maybe.diagnostics) {
    if (!d || typeof d !== "object") continue;
    diagnostics.push({
      ...(d as Diagnostic),
      code: `BOOTSTRAP_${stepName}_${(d as Diagnostic).code}`,
    });
  }
}

export function createNovelBootstrapTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  const scaffoldTool = createNovelScaffoldTool(deps);
  const importTool = createNovelImportTool(deps);
  const indexTool = createNovelIndexTool(deps);
  const gapsTool = createNovelEntityGapsTool(deps);
  const graphTool = createNovelGraphTool(deps);
  const characterReportTool = createNovelCharacterReportTool(deps);

  return tool({
    description:
      "One-shot bootstrap: scaffold → import → index → entity gaps → graphs → character report (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      fromDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      bookTitle: tool.schema.string().optional(),
      importMode: tool.schema.enum(["copy", "analyze"]).optional(),
      createStubs: tool.schema.boolean().optional(),
    },
    async execute(args: NovelBootstrapArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const fromDir = args.fromDir ? resolveMaybeRelative(rootDir, args.fromDir) : rootDir;
      const manuscriptDir = args.manuscriptDir ?? deps.config.manuscriptDir;
      const importMode = args.importMode ?? deps.config.import.defaultMode;
      const createStubs = args.createStubs ?? false;

      const scaffoldOut = await executeToolDef(scaffoldTool, {
        rootDir,
        manuscriptDir,
        bookTitle: args.bookTitle,
        writeConfigJsonc: true,
        writeTemplates: true,
        forceOverwriteTemplates: false,
      });
      const scaffoldJson = extractResultJson(
        scaffoldOut,
      ) as NovelBootstrapResultJson["results"]["scaffold"];
      pushStepDiagnostics(diagnostics, "SCAFFOLD", scaffoldJson);

      const importOut = await executeToolDef(importTool, {
        rootDir,
        fromDir,
        mode: importMode,
        manuscriptDir,
        writeConfigJsonc: false,
        writeReport: true,
      });
      const importJson = extractResultJson(
        importOut,
      ) as NovelBootstrapResultJson["results"]["import"];
      pushStepDiagnostics(diagnostics, "IMPORT", importJson);

      const indexOut = await executeToolDef(indexTool, {
        rootDir,
        manuscriptDir,
        forceWrite: false,
      });
      const indexJson = extractResultJson(indexOut) as NovelBootstrapResultJson["results"]["index"];
      pushStepDiagnostics(diagnostics, "INDEX", indexJson);

      const gapsOut = await executeToolDef(gapsTool, {
        rootDir,
        manuscriptDir,
        writeReport: true,
        createStubs,
        stubPolicy: "write",
      });
      const gapsJson = extractResultJson(
        gapsOut,
      ) as NovelBootstrapResultJson["results"]["entityGaps"];
      pushStepDiagnostics(diagnostics, "ENTITY_GAPS", gapsJson);

      const relGraphOut = await executeToolDef(graphTool, {
        rootDir,
        manuscriptDir,
        kind: "relationships",
      });
      const relGraphJson = extractResultJson(
        relGraphOut,
      ) as NovelBootstrapResultJson["results"]["graphs"]["relationships"];
      pushStepDiagnostics(diagnostics, "GRAPH_RELATIONSHIPS", relGraphJson);

      const facGraphOut = await executeToolDef(graphTool, {
        rootDir,
        manuscriptDir,
        kind: "factions",
      });
      const facGraphJson = extractResultJson(
        facGraphOut,
      ) as NovelBootstrapResultJson["results"]["graphs"]["factions"];
      pushStepDiagnostics(diagnostics, "GRAPH_FACTIONS", facGraphJson);

      const charOut = await executeToolDef(characterReportTool, {
        rootDir,
        manuscriptDir,
        writeReport: true,
      });
      const charJson = extractResultJson(
        charOut,
      ) as NovelBootstrapResultJson["results"]["characterReport"];
      pushStepDiagnostics(diagnostics, "CHARACTER_REPORT", charJson);

      const writtenFiles = [
        ...(scaffoldJson.writtenFiles ?? []),
        ...(importJson.writtenChapters ?? []),
        ...(indexJson.writtenFiles ?? []),
        ...(gapsJson.createdStubs ?? []),
        ...(gapsJson.reportPath ? [gapsJson.reportPath] : []),
        ...(relGraphJson.graphPath ? [relGraphJson.graphPath] : []),
        ...(facGraphJson.graphPath ? [facGraphJson.graphPath] : []),
        ...(charJson.reportPath ? [charJson.reportPath] : []),
      ]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

      const nextSteps = [
        "Run: /novel-extract-entities (generate candidates.json)",
        "Then: /novel-apply-candidates (apply to frontmatter safely)",
        "Then: /novel-continuity-check (validate timeline/threads)",
      ];

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelBootstrapResultJson = {
        version: 1,
        rootDir,
        fromDir,
        manuscriptDir,
        results: {
          scaffold: scaffoldJson,
          import: importJson,
          index: indexJson,
          entityGaps: gapsJson,
          graphs: { relationships: relGraphJson, factions: facGraphJson },
          characterReport: charJson,
        },
        writtenFiles,
        nextSteps,
        diagnostics: sortDiagnostics(diagnostics),
        stats: { durationMs },
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `fromDir: ${fromDir}`,
          `writtenFiles: ${writtenFiles.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics: resultJson.diagnostics,
      });
    },
  });
}

import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import { loadBuiltinCommands } from "../../features/builtin-commands";
import { getBuiltinSkillInstallFiles, loadBuiltinSkills } from "../../features/builtin-skills";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { buildCommandMarkdown } from "../../shared/opencode/artifacts";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { ensureNovelScaffold } from "../novel-scaffold/scaffold";
import type { NovelSetupArgs, NovelSetupResultJson } from "./types";

function createProjectConfigJsonc(options: { manuscriptDir: string; disableCompatTools: boolean }) {
  const compat = options.disableCompatTools
    ? { export_slashcommand_tool: false, export_skill_tool: false, export_skill_mcp_tool: false }
    : { export_slashcommand_tool: true, export_skill_tool: true, export_skill_mcp_tool: false };

  return `{
  // Project config for opencode-novel plugin.
  "manuscriptDir": "${options.manuscriptDir}",

  "agents_enabled": true,
  "agents_preset": "core",
  "agents_primary": ["novel"],
  "agent_name_prefix": "novel-",

  "compat": ${JSON.stringify(compat, null, 2).replaceAll("\n", "\n  ")}
}
`;
}

export function createNovelSetupTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Project quickstart: scaffold + minimal config + export builtin commands/skills for lowest-friction usage.",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      bookTitle: tool.schema.string().optional(),
      writeTemplates: tool.schema.boolean().optional(),
      forceOverwriteTemplates: tool.schema.boolean().optional(),
      exportCommands: tool.schema.boolean().optional(),
      exportSkills: tool.schema.boolean().optional(),
      forceOverwriteCommands: tool.schema.boolean().optional(),
      forceOverwriteSkills: tool.schema.boolean().optional(),
      writeConfigJsonc: tool.schema.boolean().optional(),
    },
    async execute(args: NovelSetupArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir ?? "manuscript";

      const exportCommands = args.exportCommands ?? true;
      const exportSkills = args.exportSkills ?? true;
      const forceOverwriteCommands = args.forceOverwriteCommands ?? false;
      const forceOverwriteSkills = args.forceOverwriteSkills ?? false;

      const writeConfigJsonc = args.writeConfigJsonc ?? true;
      const writeTemplates = args.writeTemplates ?? true;
      const forceOverwriteTemplates = args.forceOverwriteTemplates ?? false;

      const scaffold = ensureNovelScaffold({
        rootDir,
        manuscriptDirName,
        config: deps.config,
        bookTitle: args.bookTitle,
        writeConfigJsonc: false,
        writeTemplates,
        forceOverwriteTemplates,
      });
      diagnostics.push(...scaffold.diagnostics);

      let configPath: string | undefined;
      if (writeConfigJsonc) {
        const configAbs = path.join(rootDir, ".opencode", "novel.jsonc");
        configPath = toRelativePosixPath(rootDir, configAbs);
        if (!existsSync(configAbs)) {
          const content = createProjectConfigJsonc({
            manuscriptDir: manuscriptDirName,
            disableCompatTools: exportCommands || exportSkills,
          });
          writeTextFile(configAbs, content, { mode: "always" });
          scaffold.writtenFiles.push(configPath);
        } else {
          scaffold.skippedExisting.push(configPath);
        }
      }

      const disabledCommands = new Set(
        (deps.config.disabled_commands ?? []).map((c) => String(c).toLowerCase()),
      );
      const disabledSkills = new Set(
        (deps.config.disabled_skills ?? []).map((s) => String(s).toLowerCase()),
      );

      const commandsDirAbs = path.join(rootDir, ".opencode", "commands");
      const skillsDirAbs = path.join(rootDir, ".opencode", "skill");

      const writtenCommands: string[] = [];
      const skippedCommands: string[] = [];
      if (exportCommands) {
        const defs = loadBuiltinCommands();
        for (const def of Object.values(defs)) {
          if (disabledCommands.has(def.name.toLowerCase())) continue;

          const outAbs = path.join(commandsDirAbs, `${def.name}.md`);
          const outRel = toRelativePosixPath(rootDir, outAbs);
          if (!forceOverwriteCommands && existsSync(outAbs)) {
            skippedCommands.push(outRel);
            continue;
          }
          writeTextFile(outAbs, buildCommandMarkdown(def), { mode: "always" });
          writtenCommands.push(outRel);
        }
      }

      const writtenSkills: string[] = [];
      const skippedSkills: string[] = [];
      if (exportSkills) {
        const defs = loadBuiltinSkills();
        for (const def of Object.values(defs)) {
          if (disabledSkills.has(def.name.toLowerCase())) continue;
          const installFiles = getBuiltinSkillInstallFiles(def);
          for (const installFile of installFiles) {
            const outAbs = path.join(skillsDirAbs, installFile.relativePath);
            const outRel = toRelativePosixPath(rootDir, outAbs);
            if (!forceOverwriteSkills && existsSync(outAbs)) {
              skippedSkills.push(outRel);
              continue;
            }
            writeTextFile(outAbs, installFile.content, { mode: "always" });
            writtenSkills.push(outRel);
          }
        }
      }

      writtenCommands.sort();
      skippedCommands.sort();
      writtenSkills.sort();
      skippedSkills.sort();

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelSetupResultJson = {
        version: 1,
        manuscriptDir: manuscriptDirName,
        configPath,
        createdDirs: scaffold.createdDirs.sort(),
        writtenFiles: scaffold.writtenFiles.sort(),
        skippedExisting: scaffold.skippedExisting.sort(),
        commands: {
          dir: toRelativePosixPath(rootDir, commandsDirAbs),
          written: writtenCommands,
          skipped: skippedCommands,
        },
        skills: {
          dir: toRelativePosixPath(rootDir, skillsDirAbs),
          written: writtenSkills,
          skipped: skippedSkills,
        },
        stats: { durationMs },
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `createdDirs: ${resultJson.createdDirs.length}`,
          `writtenFiles: ${resultJson.writtenFiles.length}`,
          `commandsWritten: ${resultJson.commands.written.length}`,
          `skillsWritten: ${resultJson.skills.written.length}`,
          `durationMs: ${resultJson.stats.durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadBuiltinCommands } from "../src/features/builtin-commands/commands";
import { getBuiltinSkillInstallFiles, loadBuiltinSkills } from "../src/features/builtin-skills";
import { writeTextFile } from "../src/shared/fs/write";
import { buildCommandMarkdown, yamlQuote } from "../src/shared/opencode/artifacts";
import {
  renderPluginShim,
  resolvePluginInstallPaths,
  updatePluginConfig,
} from "../src/shared/opencode/plugin-entry";

type InstallTarget = "global" | "project";

type Options = {
  target: InstallTarget;
  projectRoot?: string;
  force: boolean;
  agentsPreset: "core" | "full";
  disableCompatTools: boolean;
};

function printExitHintAndExit(): never {
  console.log("[install-opencode] command finished. Exiting now.");
  console.log("[install-opencode] if the prompt does not return, press Enter once.");
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    target: "global",
    force: false,
    agentsPreset: "core",
    disableCompatTools: false,
  };

  for (const arg of argv) {
    if (arg === "--force") options.force = true;
    else if (arg === "--target=global") options.target = "global";
    else if (arg === "--target=project") options.target = "project";
    else if (arg.startsWith("--project-root="))
      options.projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--agents=core") options.agentsPreset = "core";
    else if (arg === "--agents=full") options.agentsPreset = "full";
    else if (arg === "--compat-tools=on") options.disableCompatTools = false;
    else if (arg === "--compat-tools=off") options.disableCompatTools = true;
    else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else if (arg.trim().length > 0) {
      console.warn(`[install-opencode] ignored arg: ${arg}`);
    }
  }

  if (options.target === "project" && !options.projectRoot) {
    options.projectRoot = process.cwd();
  }

  return options;
}

function printHelpAndExit(): never {
  console.log(
    `
Usage:
  bun run script/install-opencode.ts -- [options]

Options:
  --target=global|project    Install to ~/.config/opencode (global) or <project>/.opencode (project). Default: global
  --project-root=<path>      Project root when --target=project (default: cwd)
  --agents=core|full         Write novel.jsonc agents preset (default: core)
  --compat-tools=on|off      Keep or disable exporting generic tools (skill/slashcommand) via novel.jsonc (default: on)
  --force                    Overwrite existing files
  -h, --help                 Show this help
`.trim(),
  );
  process.exit(0);
}

function detectGlobalOpencodeDir(): string {
  const home = homedir();
  const primary = path.join(home, ".config", "opencode");
  if (existsSync(primary)) return primary;

  const appData = process.env.APPDATA;
  if (appData) {
    const fallback = path.join(appData, "opencode");
    if (existsSync(fallback)) return fallback;
  }

  return primary;
}

function detectOpencodeConfigPath(opencodeDir: string): string {
  const jsonc = path.join(opencodeDir, "opencode.jsonc");
  const json = path.join(opencodeDir, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return json;
}

function writeFileSafe(filePath: string, content: string, options: { force: boolean }): void {
  if (!options.force && existsSync(filePath)) {
    return;
  }
  writeTextFile(filePath, content, { mode: "always" });
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const repoRoot = path.resolve(path.join(import.meta.dir, ".."));
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error(`[install-opencode] missing ${distEntry}. Run: bun run build`);
    process.exit(1);
  }

  const installRoot =
    options.target === "global"
      ? detectGlobalOpencodeDir()
      : path.join(path.resolve(options.projectRoot ?? process.cwd()), ".opencode");

  const pluginPaths = resolvePluginInstallPaths(installRoot);
  const commandsDir = path.join(installRoot, "commands");
  const skillDir = path.join(installRoot, "skill");

  writeFileSafe(pluginPaths.entryPath, renderPluginShim(distEntry), { force: true });

  const opencodeConfigPath = detectOpencodeConfigPath(installRoot);
  const pluginConfigResult = updatePluginConfig({
    configPath: opencodeConfigPath,
    paths: pluginPaths,
  });
  if (pluginConfigResult.skippedReason) {
    console.warn(
      `[install-opencode] could not update ${opencodeConfigPath}: ${pluginConfigResult.skippedReason}`,
    );
  }

  // OpenCode 2.x rejects file plugin targets, so drop the 1.x shim.
  try {
    rmSync(pluginPaths.legacyEntryPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[install-opencode] could not remove ${pluginPaths.legacyEntryPath}: ${message}`);
  }

  const commands = loadBuiltinCommands();
  for (const def of Object.values(commands)) {
    const outPath = path.join(commandsDir, `${def.name}.md`);
    writeFileSafe(outPath, buildCommandMarkdown(def), options);
  }

  const skills = loadBuiltinSkills();
  for (const def of Object.values(skills)) {
    const files = getBuiltinSkillInstallFiles(def);
    for (const file of files) {
      const outPath = path.join(skillDir, file.relativePath);
      writeFileSafe(outPath, file.content, options);
    }
  }

  const novelConfigPath = path.join(installRoot, "novel.jsonc");
  if (options.force || !existsSync(novelConfigPath)) {
    const compat = options.disableCompatTools
      ? { export_slashcommand_tool: false, export_skill_tool: false }
      : { export_slashcommand_tool: true, export_skill_tool: true };
    const novelConfig = `{
  // Global defaults for opencode-novel plugin.
  "agents_preset": ${yamlQuote(options.agentsPreset)},
  "agents_primary": ["novel"],
  "compat": ${JSON.stringify(compat, null, 2).replaceAll("\n", "\n  ")}
}\n`;
    writeTextFile(novelConfigPath, novelConfig, { mode: "always" });
  }

  console.log("[install-opencode] done");
  console.log(`- target: ${options.target}`);
  console.log(`- opencode dir: ${installRoot}`);
  console.log(`- plugin entry: ${pluginPaths.entryPath}`);
  console.log(`- opencode config: ${opencodeConfigPath}`);
  console.log(`- commands: ${commandsDir}`);
  console.log(`- skills: ${skillDir}`);
  console.log(`- config: ${novelConfigPath}`);
  printExitHintAndExit();
}

main();

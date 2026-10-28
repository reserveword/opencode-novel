#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadBuiltinCommands } from "../src/features/builtin-commands/commands";
import { getBuiltinSkillInstallFiles, loadBuiltinSkills } from "../src/features/builtin-skills";
import { normalizeLf } from "../src/shared/fs/write";
import { buildCommandMarkdown } from "../src/shared/opencode/artifacts";
import {
  removeGeneratedPluginShim,
  resolvePluginInstallPaths,
  updatePluginConfig,
} from "../src/shared/opencode/plugin-entry";

type UninstallTarget = "global" | "project";

type Options = {
  target: UninstallTarget;
  projectRoot?: string;
  dryRun: boolean;
  force: boolean;
  removeConfig: boolean;
};

function printExitHintAndExit(): never {
  console.log("[uninstall-opencode] command finished. Exiting now.");
  console.log("[uninstall-opencode] if the prompt does not return, press Enter once.");
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    target: "global",
    dryRun: false,
    force: false,
    removeConfig: true,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--remove-config") options.removeConfig = true;
    else if (arg === "--keep-config") options.removeConfig = false;
    else if (arg === "--target=global") options.target = "global";
    else if (arg === "--target=project") options.target = "project";
    else if (arg.startsWith("--project-root="))
      options.projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else if (arg.trim().length > 0) {
      console.warn(`[uninstall-opencode] ignored arg: ${arg}`);
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
  bun run script/uninstall-opencode.ts -- [options]

Options:
  --target=global|project    Uninstall from ~/.config/opencode (global) or <project>/.opencode (project). Default: global
  --project-root=<path>      Project root when --target=project (default: cwd)
  --dry-run                  Print planned removals without changing files
  --force                    Remove files even if they appear modified
  --remove-config            Remove novel.jsonc (default)
  --keep-config              Keep novel.jsonc
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

function removeFileSafe(
  filePath: string,
  options: { dryRun: boolean },
): { removed: boolean; skipped: boolean; reason?: string } {
  if (!existsSync(filePath)) return { removed: false, skipped: true, reason: "不存在" };
  if (options.dryRun) return { removed: true, skipped: false };
  try {
    rmSync(filePath, { force: true });
    return { removed: true, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, skipped: true, reason: message };
  }
}

function removeFileIfUnmodified(
  filePath: string,
  expectedContent: string,
  options: { dryRun: boolean; force: boolean },
): { removed: boolean; skipped: boolean; reason?: string } {
  if (!existsSync(filePath)) return { removed: false, skipped: true, reason: "不存在" };
  if (options.force) return removeFileSafe(filePath, options);

  let current = "";
  try {
    current = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, skipped: true, reason: `读取失败: ${message}` };
  }

  const same = normalizeLf(current).trimEnd() === normalizeLf(expectedContent).trimEnd();
  if (!same)
    return { removed: false, skipped: true, reason: "文件已被修改（使用 --force 强制删除）" };

  return removeFileSafe(filePath, options);
}

function removeDirIfEmpty(
  dirPath: string,
  options: { dryRun: boolean },
): { removed: boolean; skipped: boolean; reason?: string } {
  if (!existsSync(dirPath)) return { removed: false, skipped: true, reason: "不存在" };

  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return { removed: false, skipped: true, reason: "不是目录" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, skipped: true, reason: message };
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(dirPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, skipped: true, reason: message };
  }

  if (entries.length > 0) return { removed: false, skipped: true, reason: "目录非空" };
  if (options.dryRun) return { removed: true, skipped: false };

  try {
    rmSync(dirPath, { recursive: true, force: true });
    return { removed: true, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { removed: false, skipped: true, reason: message };
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const installRoot =
    options.target === "global"
      ? detectGlobalOpencodeDir()
      : path.join(path.resolve(options.projectRoot ?? process.cwd()), ".opencode");

  const pluginPaths = resolvePluginInstallPaths(installRoot);
  const commandsDir = path.join(installRoot, "commands");
  const skillDir = path.join(installRoot, "skill");

  const opencodeConfigPath = detectOpencodeConfigPath(installRoot);
  const pluginConfigResult = updatePluginConfig({
    configPath: opencodeConfigPath,
    paths: pluginPaths,
    dryRun: options.dryRun,
  });

  const removedPluginShim = removeGeneratedPluginShim(pluginPaths.entryPath, options);
  const removedLegacyShim = removeFileSafe(pluginPaths.legacyEntryPath, options);
  removeDirIfEmpty(pluginPaths.pluginDir, options);

  const removedCommands: string[] = [];
  const skippedCommands: Array<{ path: string; reason: string }> = [];
  const commands = loadBuiltinCommands();
  for (const def of Object.values(commands)) {
    const outPath = path.join(commandsDir, `${def.name}.md`);
    const expected = buildCommandMarkdown(def);
    const result = removeFileIfUnmodified(outPath, expected, options);
    if (result.removed && !result.skipped) removedCommands.push(outPath);
    else skippedCommands.push({ path: outPath, reason: result.reason ?? "skipped" });
  }

  const removedSkills: string[] = [];
  const skippedSkills: Array<{ path: string; reason: string }> = [];
  const skills = loadBuiltinSkills();
  for (const def of Object.values(skills)) {
    const installFiles = getBuiltinSkillInstallFiles(def);
    const dirsToCleanup = new Set<string>([path.join(skillDir, def.name)]);
    for (const installFile of installFiles) {
      const outPath = path.join(skillDir, installFile.relativePath);
      dirsToCleanup.add(path.dirname(outPath));
      const result = removeFileIfUnmodified(outPath, installFile.content, options);
      if (result.removed && !result.skipped) removedSkills.push(outPath);
      else skippedSkills.push({ path: outPath, reason: result.reason ?? "skipped" });
    }
    const sortedDirs = Array.from(dirsToCleanup).sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      removeDirIfEmpty(dir, options);
    }
  }

  const novelConfigPath = path.join(installRoot, "novel.jsonc");
  const removedNovelConfig = options.removeConfig
    ? removeFileSafe(novelConfigPath, options)
    : { removed: false, skipped: true, reason: "keep-config" };

  console.log("[uninstall-opencode] done");
  console.log(`- target: ${options.target}`);
  console.log(`- opencode dir: ${installRoot}`);
  console.log(`- opencode config: ${opencodeConfigPath}`);
  console.log(`- removed plugin shim: ${removedPluginShim.removed && !removedPluginShim.skipped}`);
  console.log(
    `- removed legacy plugin shim: ${removedLegacyShim.removed && !removedLegacyShim.skipped}`,
  );
  console.log(`- removed plugin from config: ${pluginConfigResult.changed}`);
  console.log(`- removed commands: ${removedCommands.length}`);
  console.log(`- removed skills: ${removedSkills.length}`);
  console.log(
    `- removed novel.jsonc: ${removedNovelConfig.removed && !removedNovelConfig.skipped}`,
  );

  if (skippedCommands.length > 0) {
    console.log(`- skipped commands: ${skippedCommands.length} (use --force to delete)`);
  }
  if (skippedSkills.length > 0) {
    console.log(`- skipped skills: ${skippedSkills.length} (use --force to delete)`);
  }
  printExitHintAndExit();
}

main();

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import {
  CHARACTERS_README_TEMPLATE,
  createWorldTemplate,
  GLOSSARY_TEMPLATE,
  RULES_TEMPLATE,
  THREADS_README_TEMPLATE,
} from "./templates";

function ensureDir(path: string): { created: boolean } {
  if (existsSync(path)) {
    return { created: false };
  }
  mkdirSync(path, { recursive: true });
  return { created: true };
}

function createMinimalConfigJsonc(manuscriptDir: string): string {
  return `{
  // 项目级配置：.opencode/novel.jsonc（本文件）
  "manuscriptDir": "${manuscriptDir}",

  "index": {
    "outputDir": ".opencode/novel",
    "cacheDir": ".opencode/novel/cache",
    "stableSortLocale": "zh-CN",
    "writeDerivedFiles": true
  },

  "import": {
    "enabled": true,
    "defaultMode": "copy"
  },

  "agents_enabled": true,
  "agent_name_prefix": "novel-",

  "compat": {
    "export_slashcommand_tool": true,
    "export_skill_tool": true
  }
}
`;
}

export function ensureNovelScaffold(options: {
  rootDir: string;
  manuscriptDirName: string;
  config: NovelConfig;
  bookTitle?: string;
  writeConfigJsonc?: boolean;
  writeTemplates?: boolean;
  forceOverwriteTemplates?: boolean;
}): {
  manuscriptDir: string;
  createdDirs: string[];
  writtenFiles: string[];
  skippedExisting: string[];
  configPath?: string;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const rootDir = resolve(options.rootDir);
  const manuscriptDirName = options.manuscriptDirName;

  const manuscriptDir = join(rootDir, manuscriptDirName);
  const createdDirs: string[] = [];
  const writtenFiles: string[] = [];
  const skippedExisting: string[] = [];

  const standardDirs = [
    join(manuscriptDir, "bible"),
    join(manuscriptDir, "chapters"),
    join(manuscriptDir, "characters"),
    join(manuscriptDir, "factions"),
    join(manuscriptDir, "locations"),
    join(manuscriptDir, "threads"),
    join(manuscriptDir, "snapshots"),
  ];

  const derivedBase = join(rootDir, ".opencode", "novel");
  const derivedDirs = [
    derivedBase,
    join(derivedBase, "cache"),
    join(derivedBase, "CONTEXT_PACKS"),
    join(derivedBase, "GRAPH"),
  ];

  for (const dir of [...standardDirs, ...derivedDirs]) {
    const { created } = ensureDir(dir);
    const rel = toRelativePosixPath(rootDir, dir);
    if (created) createdDirs.push(rel);
    else skippedExisting.push(rel);
  }

  const writeTemplates = options.writeTemplates ?? true;
  const forceOverwriteTemplates = options.forceOverwriteTemplates ?? false;
  const templates: Array<{ path: string; content: string }> = [
    {
      path: join(manuscriptDir, "bible", "world.md"),
      content: createWorldTemplate(options.bookTitle),
    },
    { path: join(manuscriptDir, "bible", "rules.md"), content: RULES_TEMPLATE },
    { path: join(manuscriptDir, "bible", "glossary.md"), content: GLOSSARY_TEMPLATE },
    { path: join(manuscriptDir, "characters", "README.md"), content: CHARACTERS_README_TEMPLATE },
    { path: join(manuscriptDir, "threads", "README.md"), content: THREADS_README_TEMPLATE },
  ];

  if (writeTemplates) {
    for (const template of templates) {
      const rel = toRelativePosixPath(rootDir, template.path);
      const exists = existsSync(template.path);
      if (exists && !forceOverwriteTemplates) {
        skippedExisting.push(rel);
        continue;
      }
      const { changed } = writeTextFile(template.path, template.content, {
        mode: "always",
      });
      if (changed) writtenFiles.push(rel);
    }
  }

  const writeConfigJsonc = options.writeConfigJsonc ?? true;
  let configPath: string | undefined;
  if (writeConfigJsonc) {
    const opencodeDir = join(rootDir, ".opencode");
    ensureDir(opencodeDir);

    const novelConfigPath = join(opencodeDir, "novel.jsonc");
    configPath = toRelativePosixPath(rootDir, novelConfigPath);
    if (existsSync(novelConfigPath)) {
      skippedExisting.push(configPath);
    } else {
      const content = createMinimalConfigJsonc(manuscriptDirName);
      writeTextFile(novelConfigPath, content, { mode: "always" });
      writtenFiles.push(configPath);
    }
  }

  return {
    manuscriptDir: manuscriptDirName,
    createdDirs: createdDirs.sort(),
    writtenFiles: writtenFiles.sort(),
    skippedExisting: skippedExisting.sort(),
    configPath,
    diagnostics,
  };
}

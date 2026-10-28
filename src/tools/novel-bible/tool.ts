import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { renderBibleSummaryMd, renderGlossaryMd } from "./render";
import type { BibleRule, GlossaryTerm, NovelBibleArgs, NovelBibleResultJson } from "./types";

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parseRulesFromFile(options: {
  relPath: string;
  content: string;
  diagnostics: Diagnostic[];
}): BibleRule[] {
  const lines = normalizeText(options.content).split("\n");
  const rules: BibleRule[] = [];
  let autoIndex = 1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const explicit = line.match(/^\s*(R-[0-9]{3,}|R-[A-Z]+-[0-9]{1,})(?:[：:])\s*(.+)$/);
    if (explicit) {
      rules.push({
        id: explicit[1],
        text: explicit[2].trim(),
        sourceFile: options.relPath,
        line: i + 1,
      });
      continue;
    }

    const listItem = line.match(/^\s*(?:-|\d+\.)\s+(.+)$/);
    if (listItem) {
      const id = `R-AUTO-${autoIndex}`;
      autoIndex += 1;
      rules.push({
        id,
        text: listItem[1].trim(),
        sourceFile: options.relPath,
        line: i + 1,
      });
      options.diagnostics.push({
        severity: "warn",
        code: "BIBLE_RULE_AUTO_ID",
        message: `规则缺少编号，已生成临时编号 ${id}`,
        file: options.relPath,
        line: i + 1,
      });
    }
  }

  return rules;
}

function parseGlossaryFromFile(options: {
  relPath: string;
  content: string;
  diagnostics: Diagnostic[];
}): GlossaryTerm[] {
  const lines = normalizeText(options.content).split("\n");
  const terms: GlossaryTerm[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bullet = line.match(/^\s*-\s*([^：:]{1,80})(?:[：:])\s*(.+)$/);
    const bold = line.match(/^\s*\\*\\*([^*]{1,80})\\*\\*(?:[：:])\s*(.+)$/);

    const match = bullet ?? bold;
    if (!match) continue;

    const term = match[1].trim();
    const definition = match[2]?.trim();
    if (!term) continue;

    if (seen.has(term)) {
      options.diagnostics.push({
        severity: "warn",
        code: "BIBLE_GLOSSARY_DUP",
        message: `名词表重复词条: ${term}（已保留首次定义）`,
        file: options.relPath,
      });
      continue;
    }
    seen.add(term);
    terms.push({ term, definition, sourceFile: options.relPath });
  }

  return terms;
}

export function createNovelBibleTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description: "Build bible summary and glossary from manuscript/bible/*.md (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      writeDerivedFiles: tool.schema.boolean().optional(),
    },
    async execute(args: NovelBibleArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const manuscriptBibleDir = path.join(rootDir, manuscriptDirName, "bible");
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeDerivedFiles = args.writeDerivedFiles ?? true;

      const bibleFiles = ["world.md", "rules.md", "glossary.md"];
      const rules: BibleRule[] = [];
      const glossary: GlossaryTerm[] = [];

      for (const name of bibleFiles) {
        const abs = path.join(manuscriptBibleDir, name);
        if (!existsSync(abs)) continue;
        const rel = toRelativePosixPath(rootDir, abs);
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        rules.push(...parseRulesFromFile({ relPath: rel, content, diagnostics }));
        glossary.push(...parseGlossaryFromFile({ relPath: rel, content, diagnostics }));
      }

      // Deduplicate rules by id (keep first)
      const ruleById = new Map<string, BibleRule>();
      for (const rule of rules) {
        if (!ruleById.has(rule.id)) ruleById.set(rule.id, rule);
        else {
          diagnostics.push({
            severity: "warn",
            code: "BIBLE_RULE_DUP",
            message: `规则编号重复: ${rule.id}（已保留首次出现）`,
            file: rule.sourceFile,
            line: rule.line,
          });
        }
      }

      const finalRules = [...ruleById.values()].sort((a, b) => a.id.localeCompare(b.id));
      const finalGlossary = glossary.sort((a, b) => a.term.localeCompare(b.term));

      const summaryPathAbs = path.join(outputDir, "BIBLE_SUMMARY.md");
      const glossaryPathAbs = path.join(outputDir, "GLOSSARY.md");
      const summaryPathRel = toRelativePosixPath(rootDir, summaryPathAbs);
      const glossaryPathRel = toRelativePosixPath(rootDir, glossaryPathAbs);

      if (writeDerivedFiles) {
        writeTextFile(summaryPathAbs, renderBibleSummaryMd(finalRules), { mode: "if-changed" });
        writeTextFile(glossaryPathAbs, renderGlossaryMd(finalGlossary), { mode: "if-changed" });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelBibleResultJson = {
        version: 1,
        summaryPath: writeDerivedFiles ? summaryPathRel : undefined,
        glossaryPath: writeDerivedFiles ? glossaryPathRel : undefined,
        rules: finalRules,
        glossary: finalGlossary,
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `rules: ${finalRules.length}`,
          `glossary: ${finalGlossary.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

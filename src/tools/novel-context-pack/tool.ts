import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { normalizeLf, writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import type {
  NovelContextPackArgs,
  NovelContextPackResultJson,
  NovelContextPackTask,
} from "./types";

function extractFirstParagraph(markdownBody: string, maxChars: number): string {
  const text = normalizeLf(markdownBody);
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }
    if (line.startsWith("#")) {
      // skip headings
      if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }
    current.push(line);
    if (current.join("\n").length >= maxChars) {
      break;
    }
  }
  if (current.length > 0) paragraphs.push(current.join("\n").trim());
  const first = paragraphs.find((p) => p.length > 0) ?? "";
  return first.length > maxChars ? first.slice(0, maxChars) : first;
}

function applyRedaction(text: string, patterns: string[], diagnostics: Diagnostic[]): string {
  let result = text;
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, "g");
      result = result.replace(re, "[REDACTED]");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        severity: "warn",
        code: "CONTEXT_REDACTION_INVALID_PATTERN",
        message: `脱敏正则无效: ${pattern} (${message})`,
      });
    }
  }
  return result;
}

function buildPackPath(
  _rootDir: string,
  outputDir: string,
  task: NovelContextPackTask,
  key: string,
): string {
  const fileName = `${task}-${key}.md`;
  return path.join(outputDir, "CONTEXT_PACKS", fileName);
}

export function createNovelContextPackTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description: "Create a minimal, explainable context pack for LLM tasks (budgeted by maxChars).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      task: tool.schema.enum(["draft", "review", "rewrite", "continuity", "foreshadowing"]),
      chapter_id: tool.schema.string().optional(),
      thread_id: tool.schema.string().optional(),
      budget: tool.schema.object({ maxChars: tool.schema.number().int().positive() }).optional(),
      include: tool.schema
        .object({
          bible: tool.schema.boolean().optional(),
          characters: tool.schema.boolean().optional(),
          openThreads: tool.schema.boolean().optional(),
          lastChapters: tool.schema.number().int().nonnegative().optional(),
        })
        .optional(),
      redaction: tool.schema
        .object({
          enabled: tool.schema.boolean(),
          patterns: tool.schema.array(tool.schema.string()),
        })
        .optional(),
      writeFile: tool.schema.boolean().optional(),
    },
    async execute(args: NovelContextPackArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const budgetChars = args.budget?.maxChars ?? deps.config.contextPack.maxChars;
      const include = {
        bible: args.include?.bible ?? deps.config.contextPack.include.bible,
        characters: args.include?.characters ?? deps.config.contextPack.include.characters,
        openThreads: args.include?.openThreads ?? deps.config.contextPack.include.openThreads,
        lastChapters: args.include?.lastChapters ?? deps.config.contextPack.include.lastChapters,
      };
      const redaction = args.redaction ?? deps.config.contextPack.redaction;
      const writeFile = args.writeFile ?? true;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const included: Array<{ path: string; reason: string; chars: number }> = [];
      const sections: string[] = [];

      const outputDir = path.isAbsolute(deps.config.index.outputDir)
        ? deps.config.index.outputDir
        : path.resolve(path.join(rootDir, deps.config.index.outputDir));

      const addSection = (relPath: string, reason: string, content: string) => {
        const remaining = budgetChars - sections.join("\n").length;
        if (remaining <= 0) return;
        const truncated = content.length > remaining ? content.slice(0, remaining) : content;
        sections.push(truncated);
        included.push({ path: relPath, reason, chars: truncated.length });
      };

      const chapterKey = args.chapter_id?.trim();
      const threadKey = args.thread_id?.trim();

      if (!chapterKey && !threadKey) {
        diagnostics.push({
          severity: "warn",
          code: "CONTEXT_NO_TARGET",
          message: "未指定 chapter_id 或 thread_id，将按全局最小集打包。",
        });
      }

      // Bible (prefer derived summary if exists)
      if (include.bible) {
        const derivedSummaryRel = `${deps.config.index.outputDir}/BIBLE_SUMMARY.md`.replaceAll(
          "\\",
          "/",
        );
        const derivedSummaryAbs = path.join(rootDir, derivedSummaryRel.replaceAll("/", path.sep));
        if (existsSync(derivedSummaryAbs)) {
          const content = readTextFileSync(derivedSummaryAbs);
          addSection(
            derivedSummaryRel,
            "bible summary (derived)",
            `## Bible Summary\n\n${content}\n`,
          );
        } else {
          const worldRel = `${manuscriptDirName}/bible/world.md`;
          const worldAbs = path.join(rootDir, worldRel.replaceAll("/", path.sep));
          if (existsSync(worldAbs)) {
            const content = readTextFileSync(worldAbs, { encoding: deps.config.encoding });
            addSection(worldRel, "bible world.md", `## World Bible\n\n${content.slice(0, 2000)}\n`);
          }
        }
      }

      const chaptersById = [...scan.entities.chapters].sort((a, b) =>
        a.chapter_id.localeCompare(b.chapter_id),
      );
      const chapterIndex = new Map(chaptersById.map((c, idx) => [c.chapter_id, idx] as const));

      const includeChapter = (chapterId: string, reason: string) => {
        const chapter = scan.entities.chapters.find((c) => c.chapter_id === chapterId);
        if (!chapter) return;
        const abs = fromRelativePosixPath(rootDir, chapter.path);
        if (!existsSync(abs)) return;
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: chapter.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        const summary =
          chapter.summary ?? (typeof parsed.data.summary === "string" ? parsed.data.summary : "");
        const snippet = extractFirstParagraph(parsed.body, 600);
        const block = [
          `## Chapter ${chapter.chapter_id}: ${chapter.title ?? ""}`.trim(),
          summary ? `**Summary**: ${summary}` : "",
          snippet ? `**Snippet**:\n\n${snippet}` : "",
          "",
        ]
          .filter(Boolean)
          .join("\n\n");
        addSection(chapter.path, reason, block);
      };

      const includeCharacter = (characterId: string, reason: string) => {
        const character = scan.entities.characters.find((c) => c.id === characterId);
        if (!character) return;
        const abs = fromRelativePosixPath(rootDir, character.path);
        if (!existsSync(abs)) return;
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: character.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        const name = typeof parsed.data.name === "string" ? parsed.data.name : "";
        const motivation = typeof parsed.data.motivation === "string" ? parsed.data.motivation : "";
        const desire = typeof parsed.data.desire === "string" ? parsed.data.desire : "";
        const block = [
          `## Character ${characterId}${name ? `: ${name}` : ""}`,
          motivation ? `- motivation: ${motivation}` : "",
          desire ? `- desire: ${desire}` : "",
          "",
        ]
          .filter(Boolean)
          .join("\n");
        addSection(character.path, reason, block);
      };

      const includeThread = (threadId: string, reason: string) => {
        const thread = scan.entities.threads.find((t) => t.thread_id === threadId);
        if (!thread) return;
        const abs = fromRelativePosixPath(rootDir, thread.path);
        if (!existsSync(abs)) return;
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: thread.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        const status =
          typeof parsed.data.status === "string" ? parsed.data.status : (thread.status ?? "");
        const closePlan = typeof parsed.data.close_plan === "string" ? parsed.data.close_plan : "";
        const block = [
          `## Thread ${threadId}`,
          status ? `- status: ${status}` : "",
          closePlan ? `- close_plan: ${closePlan}` : "",
          "",
        ]
          .filter(Boolean)
          .join("\n");
        addSection(thread.path, reason, block);
      };

      if (chapterKey) {
        includeChapter(chapterKey, "target chapter");

        const target = scan.entities.chapters.find((c) => c.chapter_id === chapterKey);
        if (!target) {
          diagnostics.push({
            severity: "error",
            code: "CONTEXT_CHAPTER_NOT_FOUND",
            message: `未找到章节: ${chapterKey}`,
          });
        } else {
          const last = include.lastChapters;
          const idx = chapterIndex.get(chapterKey) ?? -1;
          if (last > 0 && idx >= 0) {
            const start = Math.max(0, idx - last);
            for (let i = start; i < idx; i += 1) {
              includeChapter(chaptersById[i].chapter_id, "recent chapter");
            }
          }

          if (include.characters) {
            for (const characterId of target.characters ?? []) {
              includeCharacter(characterId, "chapter.characters");
            }
          }
          if (include.openThreads) {
            const closedInChapter = new Set(target.threads_closed ?? []);
            const threadIds = new Set([
              ...(target.threads_opened ?? []),
              ...(target.threads_advanced ?? []),
            ]);
            for (const threadId of threadIds) {
              if (closedInChapter.has(threadId)) continue;

              const thread = scan.entities.threads.find((t) => t.thread_id === threadId);
              const status = (thread?.status ?? "").toLowerCase();
              if (status === "closed") continue;

              includeThread(threadId, "chapter.open_threads");
            }
          }
        }
      }

      if (threadKey) {
        includeThread(threadKey, "target thread");
        const thread = scan.entities.threads.find((t) => t.thread_id === threadKey);
        if (!thread) {
          diagnostics.push({
            severity: "error",
            code: "CONTEXT_THREAD_NOT_FOUND",
            message: `未找到线程: ${threadKey}`,
          });
        }
      }

      let packContent = [
        "<!-- novel:derived v1; DO NOT EDIT BY HAND -->",
        "",
        `# CONTEXT PACK (${args.task})`,
        "",
        ...sections,
        "",
      ].join("\n");

      if (redaction.enabled) {
        packContent = applyRedaction(packContent, redaction.patterns, diagnostics);
      }

      const key = chapterKey ?? threadKey ?? "all";
      const packPathAbs = buildPackPath(rootDir, outputDir, args.task, key);
      const packPathRel = toRelativePosixPath(rootDir, packPathAbs);

      if (writeFile) {
        writeTextFile(packPathAbs, packContent, { mode: "always" });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelContextPackResultJson = {
        version: 1,
        packPath: writeFile ? packPathRel : undefined,
        included,
        stats: { totalChars: packContent.length, budgetChars },
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `task: ${args.task}`,
          `totalChars: ${packContent.length}`,
          `budgetChars: ${budgetChars}`,
          `included: ${included.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

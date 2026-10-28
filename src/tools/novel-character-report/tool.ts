import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderCharacterReportMd } from "./render";
import type {
  CharacterReportItem,
  NovelCharacterReportArgs,
  NovelCharacterReportResultJson,
} from "./types";

function buildArcSummary(data: Record<string, unknown>): string | undefined {
  const arc = data.arc;
  if (Array.isArray(arc)) {
    const parts: string[] = [];
    for (const item of arc) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const phase = typeof obj.phase === "string" ? obj.phase : undefined;
      const state = typeof obj.state === "string" ? obj.state : undefined;
      if (phase || state) {
        parts.push([phase, state].filter(Boolean).join(": "));
      }
    }
    return parts.length > 0 ? parts.join(" / ") : undefined;
  }

  const beats = data.arc_beats;
  if (Array.isArray(beats)) {
    const parts = beats.filter((x) => typeof x === "string") as string[];
    return parts.length > 0 ? parts.join(" / ") : undefined;
  }

  return undefined;
}

function detectMissingFields(data: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const required = ["name", "motivation", "desire"] as const;
  for (const key of required) {
    if (typeof data[key] !== "string" || String(data[key]).trim().length === 0) {
      missing.push(key);
    }
  }
  if (!data.voice) missing.push("voice");
  if (!data.arc && !data.arc_beats) missing.push("arc/arc_beats");
  return missing;
}

export function createNovelCharacterReportTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Aggregate character appearances/threads/arc summary into CHARACTER_REPORT.md (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      writeReport: tool.schema.boolean().optional(),
    },
    async execute(args: NovelCharacterReportArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const chaptersById = [...scan.entities.chapters].sort((a, b) =>
        a.chapter_id.localeCompare(b.chapter_id),
      );

      const stats = new Map<
        string,
        { appearances: number; first?: string; last?: string; threads: Set<string> }
      >();
      for (const chapter of chaptersById) {
        const threads = [
          ...(chapter.threads_opened ?? []),
          ...(chapter.threads_advanced ?? []),
          ...(chapter.threads_closed ?? []),
        ];
        const involvedChars = new Set(chapter.characters ?? []);
        for (const charId of involvedChars) {
          const entry = stats.get(charId) ?? { appearances: 0, threads: new Set<string>() };
          entry.appearances += 1;
          if (!entry.first) entry.first = chapter.chapter_id;
          entry.last = chapter.chapter_id;
          for (const t of threads) entry.threads.add(t);
          stats.set(charId, entry);
        }
      }

      const items: CharacterReportItem[] = [];
      for (const character of scan.entities.characters) {
        const abs = fromRelativePosixPath(rootDir, character.path);
        const content = existsSync(abs)
          ? readTextFileSync(abs, { encoding: deps.config.encoding })
          : "";
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: character.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        const entry = stats.get(character.id);
        const arcSummary = buildArcSummary(parsed.data as Record<string, unknown>);
        const missingFields = detectMissingFields(parsed.data as Record<string, unknown>);

        items.push({
          id: character.id,
          path: character.path,
          appearances: entry?.appearances ?? 0,
          first_seen: entry?.first,
          last_seen: entry?.last,
          threads_involved: entry
            ? Array.from(entry.threads).sort((a, b) => a.localeCompare(b))
            : [],
          arc_summary: arcSummary,
          missingFields: missingFields.length > 0 ? missingFields : undefined,
        });
      }

      items.sort((a, b) => a.id.localeCompare(b.id));

      const reportPathAbs = path.join(outputDir, "CHARACTER_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);
      if (writeReport) {
        writeTextFile(reportPathAbs, renderCharacterReportMd(items), { mode: "if-changed" });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelCharacterReportResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        characters: items,
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [`characters: ${items.length}`, `durationMs: ${durationMs}`],
        resultJson,
        diagnostics,
      });
    },
  });
}

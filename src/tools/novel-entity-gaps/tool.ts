import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { toRelativePosixPath } from "../../shared/fs/paths";
import { writeTextFile } from "../../shared/fs/write";
import { hash8 } from "../../shared/hashing/hash8";
import { buildFrontmatterFile } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderEntityGapsMd } from "./render";
import type {
  MissingEntityRef,
  NovelEntityGapsArgs,
  NovelEntityGapsResultJson,
  NovelEntityKind,
  OrphanEntity,
} from "./types";

const KIND_DIR: Record<NovelEntityKind, string> = {
  characters: "characters",
  threads: "threads",
  factions: "factions",
  locations: "locations",
};

function suggestedEntityPath(manuscriptDir: string, kind: NovelEntityKind, id: string): string {
  return `${manuscriptDir}/${KIND_DIR[kind]}/${id}.md`;
}

function ensureStubContent(kind: NovelEntityKind, id: string): string {
  const fm: Record<string, unknown> =
    kind === "threads"
      ? { thread_id: id, type: "mystery", status: "open", close_plan: "TODO" }
      : { id, name: id };
  const body = `# ${id}\n\n## TODO\n- 补全该实体的关键信息\n`;
  return buildFrontmatterFile(fm, body);
}

export function createNovelEntityGapsTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Find missing/orphan entities based on scan snapshot; optionally create deterministic stubs (no正文改写).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      writeReport: tool.schema.boolean().optional(),
      createStubs: tool.schema.boolean().optional(),
      stubPolicy: tool.schema.enum(["skip", "write"]).optional(),
    },
    async execute(args: NovelEntityGapsArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;
      const createStubs = args.createStubs ?? false;
      const stubPolicy = args.stubPolicy ?? "write";

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const defined = {
        characters: new Set(scan.entities.characters.map((c) => c.id)),
        threads: new Set(scan.entities.threads.map((t) => t.thread_id)),
        factions: new Set(scan.entities.factions.map((f) => f.id)),
        locations: new Set(scan.entities.locations.map((l) => l.id)),
      };

      const referencesByKind: Record<
        NovelEntityKind,
        Map<string, Array<{ chapter_id: string; path: string }>>
      > = {
        characters: new Map(),
        threads: new Map(),
        factions: new Map(),
        locations: new Map(),
      };

      for (const chapter of scan.entities.chapters) {
        const addRef = (kind: NovelEntityKind, id: string) => {
          const list = referencesByKind[kind].get(id) ?? [];
          list.push({ chapter_id: chapter.chapter_id, path: chapter.path });
          referencesByKind[kind].set(id, list);
        };

        for (const id of chapter.characters ?? []) addRef("characters", id);
        for (const id of chapter.factions ?? []) addRef("factions", id);
        for (const id of chapter.locations ?? []) addRef("locations", id);
        if (chapter.timeline?.location) addRef("locations", chapter.timeline.location);

        for (const id of [
          ...(chapter.threads_opened ?? []),
          ...(chapter.threads_advanced ?? []),
          ...(chapter.threads_closed ?? []),
        ]) {
          addRef("threads", id);
        }
      }

      const missing: MissingEntityRef[] = [];
      const orphans: OrphanEntity[] = [];

      const kinds: NovelEntityKind[] = ["characters", "threads", "factions", "locations"];
      for (const kind of kinds) {
        const referencedIds = [...referencesByKind[kind].keys()].sort((a, b) => a.localeCompare(b));
        const definedIds = [...defined[kind]].sort((a, b) => a.localeCompare(b));

        for (const id of referencedIds) {
          if (defined[kind].has(id)) continue;
          const referencedBy = (referencesByKind[kind].get(id) ?? []).sort(
            (a, b) => a.chapter_id.localeCompare(b.chapter_id) || a.path.localeCompare(b.path),
          );
          missing.push({
            kind,
            id,
            referencedBy,
            suggestedPath: suggestedEntityPath(manuscriptDirName, kind, id),
          });
        }

        const referencedSet = new Set(referencedIds);
        for (const id of definedIds) {
          if (!referencedSet.has(id)) {
            const pathRel =
              kind === "threads"
                ? scan.entities.threads.find((t) => t.thread_id === id)?.path
                : kind === "characters"
                  ? scan.entities.characters.find((c) => c.id === id)?.path
                  : kind === "factions"
                    ? scan.entities.factions.find((f) => f.id === id)?.path
                    : scan.entities.locations.find((l) => l.id === id)?.path;
            if (pathRel) {
              orphans.push({ kind, id, path: pathRel });
            }
          }
        }
      }

      missing.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      orphans.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

      const createdStubs: string[] = [];
      if (createStubs && stubPolicy === "write") {
        for (const m of missing) {
          const absPath = path.join(rootDir, m.suggestedPath.replaceAll("/", path.sep));
          let finalAbs = absPath;
          let finalRel = m.suggestedPath;
          if (existsSync(absPath)) {
            const suffix = hash8(`${m.kind}:${m.id}`);
            finalAbs = absPath.replace(/\\.md$/i, `.import-${suffix}.md`);
            finalRel = toRelativePosixPath(rootDir, finalAbs);
          }
          if (existsSync(finalAbs)) continue;
          writeTextFile(finalAbs, ensureStubContent(m.kind, m.id), { mode: "always" });
          createdStubs.push(finalRel);
        }
        createdStubs.sort();
      }

      const reportPathAbs = path.join(outputDir, "ENTITY_GAPS.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);
      if (writeReport) {
        writeTextFile(reportPathAbs, renderEntityGapsMd({ missing, orphans }), {
          mode: "if-changed",
        });
      }

      // Cache (optional but recommended)
      const cachePathAbs = path.join(rootDir, deps.config.index.cacheDir, "entity-gaps.json");
      writeTextFile(
        cachePathAbs,
        `${JSON.stringify({ version: 1, missing, orphans }, null, 2)}\n`,
        {
          mode: "always",
        },
      );

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelEntityGapsResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        missing,
        orphans,
        createdStubs,
        nextSteps: [
          "/novel-index（更新 INDEX/TIMELINE/THREADS_REPORT）",
          "/novel-continuity-check（复核引用一致性）",
        ],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `missing: ${missing.length}`,
          `orphans: ${orphans.length}`,
          `createdStubs: ${createdStubs.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

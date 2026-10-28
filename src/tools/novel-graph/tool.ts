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
import { renderMermaidGraphTd } from "./render";
import type { NovelGraphArgs, NovelGraphKind, NovelGraphResultJson } from "./types";

type Relation = { source: string; target: string; type: string };

function escapeMermaidLabel(text: string): string {
  return text.replaceAll('"', "'").replaceAll("\n", " ").trim();
}

function displayEntityLabel(id: string, name?: string): string {
  const cleanName = name?.trim();
  return cleanName ? `${cleanName} (${id})` : id;
}

function buildNodeDef(id: string, label: string): string {
  return `${id}["${escapeMermaidLabel(label)}"]`;
}

function parseExplicitRelations(
  rootDir: string,
  entityPaths: Array<{ id: string; path: string }>,
  fieldName: string,
  diagnostics: Diagnostic[],
  encoding: NovelConfig["encoding"],
): Relation[] {
  const relations: Relation[] = [];
  for (const entity of entityPaths) {
    const abs = fromRelativePosixPath(rootDir, entity.path);
    if (!existsSync(abs)) continue;
    const content = readTextFileSync(abs, { encoding });
    const parsed = parseFrontmatter<Record<string, unknown>>(content, {
      file: entity.path,
      strict: false,
    });
    diagnostics.push(...parsed.diagnostics);
    const data = parsed.data;
    const raw = data[fieldName];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const target = typeof obj.target === "string" ? obj.target : undefined;
      const type = typeof obj.type === "string" ? obj.type : undefined;
      if (!target || !type) continue;
      relations.push({ source: entity.id, target, type });
    }
  }
  return relations;
}

function countCooccurrence(chapters: Array<{ characters?: string[] }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const chapter of chapters) {
    const chars = (chapter.characters ?? []).filter(Boolean);
    const unique = Array.from(new Set(chars)).sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const a = unique[i];
        const b = unique[j];
        const key = `${a}|||${b}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
  }
  return map;
}

export function createNovelGraphTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Generate Mermaid graphs (character relationships / factions) from manuscript facts (deterministic).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      kind: tool.schema.enum(["relationships", "factions"]),
      writeFile: tool.schema.boolean().optional(),
      preferExplicitRelations: tool.schema.boolean().optional(),
      cooccurrenceMinWeight: tool.schema.number().int().positive().optional(),
    },
    async execute(args: NovelGraphArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const kind: NovelGraphKind = args.kind;
      const writeFile = args.writeFile ?? true;
      const preferExplicitRelations = args.preferExplicitRelations ?? true;
      const cooccurrenceMinWeight = args.cooccurrenceMinWeight ?? 2;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      let nodes: string[] = [];
      let edges: string[] = [];

      if (kind === "relationships") {
        const nameById = new Map<string, string | undefined>(
          scan.entities.characters.map((c) => [c.id, c.name]),
        );
        const entityPaths = scan.entities.characters.map((c) => ({ id: c.id, path: c.path }));

        const explicit = preferExplicitRelations
          ? parseExplicitRelations(
              rootDir,
              entityPaths,
              "relationships",
              diagnostics,
              deps.config.encoding,
            )
          : [];

        if (explicit.length > 0) {
          const nodeIds = new Set<string>();
          for (const r of explicit) {
            nodeIds.add(r.source);
            nodeIds.add(r.target);
          }
          nodes = Array.from(nodeIds)
            .sort((a, b) => a.localeCompare(b))
            .map((id) => buildNodeDef(id, displayEntityLabel(id, nameById.get(id))));
          edges = explicit
            .sort(
              (a, b) =>
                a.source.localeCompare(b.source) ||
                a.target.localeCompare(b.target) ||
                a.type.localeCompare(b.type),
            )
            .map((r) => `${r.source} -->|${r.type}| ${r.target}`);
        } else {
          const counts = countCooccurrence(scan.entities.chapters);
          const nodeIds = new Set<string>(scan.entities.characters.map((c) => c.id));
          nodes = Array.from(nodeIds)
            .sort((a, b) => a.localeCompare(b))
            .map((id) => buildNodeDef(id, displayEntityLabel(id, nameById.get(id))));
          edges = Array.from(counts.entries())
            .filter(([, count]) => count >= cooccurrenceMinWeight)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([key, count]) => {
              const [aId, bId] = key.split("|||");
              return `${aId} ---|${count}| ${bId}`;
            });
        }
      } else {
        const nameById = new Map<string, string | undefined>(
          scan.entities.factions.map((f) => [f.id, f.name]),
        );
        const entityPaths = scan.entities.factions.map((f) => ({ id: f.id, path: f.path }));
        const explicit = parseExplicitRelations(
          rootDir,
          entityPaths,
          "relationships",
          diagnostics,
          deps.config.encoding,
        );

        const nodeIds = new Set<string>(scan.entities.factions.map((f) => f.id));
        nodes = Array.from(nodeIds)
          .sort((a, b) => a.localeCompare(b))
          .map((id) => buildNodeDef(id, displayEntityLabel(id, nameById.get(id))));

        if (explicit.length === 0) {
          diagnostics.push({
            severity: "info",
            code: "GRAPH_FACTIONS_NO_RELATIONSHIPS",
            message: "势力卡未提供 relationships 字段，将只输出节点（无边）。",
          });
        }
        edges = explicit
          .sort(
            (a, b) =>
              a.source.localeCompare(b.source) ||
              a.target.localeCompare(b.target) ||
              a.type.localeCompare(b.type),
          )
          .map((r) => `${r.source} -->|${r.type}| ${r.target}`);
      }

      const fileName = kind === "relationships" ? "RELATIONSHIPS.mmd" : "FACTIONS.mmd";
      const graphPathAbs = path.join(outputDir, "GRAPH", fileName);
      const graphPathRel = toRelativePosixPath(rootDir, graphPathAbs);

      if (writeFile) {
        const title = kind === "relationships" ? "RELATIONSHIPS" : "FACTIONS";
        const mermaid = renderMermaidGraphTd({ title, nodes, edges });
        writeTextFile(graphPathAbs, mermaid, { mode: "if-changed" });
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelGraphResultJson = {
        version: 1,
        kind,
        graphPath: writeFile ? graphPathRel : undefined,
        stats: { nodes: nodes.length, edges: edges.length },
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `kind: ${kind}`,
          `nodes: ${nodes.length}`,
          `edges: ${edges.length}`,
          `durationMs: ${durationMs}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

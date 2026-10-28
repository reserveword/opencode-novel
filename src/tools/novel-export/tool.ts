import { existsSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { ensureDirForFile, normalizeLf, writeTextFile } from "../../shared/fs/write";
import { createSha256Hex, createSha256HexFromBytes } from "../../shared/hashing/sha256";
import { buildFrontmatterFile, parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolContext, type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { markdownToDocxBytes } from "./docx";
import { chaptersToEpubBytes } from "./epub";
import { runPreflight } from "./preflight";
import { markdownToHtml, wrapHtmlDocument } from "./render";
import type {
  NovelChapterOrder,
  NovelDocxTemplate,
  NovelExportArgs,
  NovelExportFormat,
  NovelExportManifest,
  NovelExportResultJson,
  NovelExportResultJsonV1,
  NovelExportResultJsonV2,
} from "./types";

function sortByTimelineKey(
  a: { date?: string; start?: string; chapter_id: string },
  b: { date?: string; start?: string; chapter_id: string },
): number {
  const aKey = `${a.date ?? ""} ${a.start ?? ""}`.trim();
  const bKey = `${b.date ?? ""} ${b.start ?? ""}`.trim();
  const aHas = aKey.length > 0;
  const bHas = bKey.length > 0;
  if (aHas && bHas) {
    const cmp = aKey.localeCompare(bKey);
    if (cmp !== 0) return cmp;
    return a.chapter_id.localeCompare(b.chapter_id);
  }
  if (aHas) return -1;
  if (bHas) return 1;
  return a.chapter_id.localeCompare(b.chapter_id);
}

function ensureChapterHeading(markdownBody: string, title: string): string {
  const body = normalizeLf(markdownBody).trimStart();
  if (body.startsWith("# ")) return body;
  return `# ${title}\n\n${body}`.trimEnd();
}

export function createNovelExportTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Export novel by merging chapters into a single MD/HTML/EPUB/DOCX file (deterministic ordering). If format is omitted, exports config.export.formats.",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      format: tool.schema.enum(["md", "html", "epub", "docx"]).optional(),
      outputDir: tool.schema.string().optional(),
      title: tool.schema.string().optional(),
      chapterOrder: tool.schema.enum(["by_id", "by_timeline", "custom"]).optional(),
      customOrder: tool.schema.array(tool.schema.string()).optional(),
      includeFrontmatter: tool.schema.boolean().optional(),
      writeFile: tool.schema.boolean().optional(),
      docxTemplate: tool.schema.enum(["default", "manuscript"]).optional(),
      preflight: tool.schema.boolean().optional(),
      preflightChecks: tool.schema
        .array(
          tool.schema.enum([
            "index",
            "continuity",
            "foreshadowing",
            "style",
            "structure",
            "scene",
            "arc",
            "pacing",
          ]),
        )
        .optional(),
      preflightFailOn: tool.schema.enum(["error", "warn"]).optional(),
    },
    async execute(args: NovelExportArgs, context?: ToolContext) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.export.outputDir));
      const title = (args.title ?? "").trim() || path.basename(rootDir);
      const chapterOrder: NovelChapterOrder = args.chapterOrder ?? deps.config.export.chapterOrder;
      const includeFrontmatter = args.includeFrontmatter ?? deps.config.export.includeFrontmatter;
      const writeFile = args.writeFile ?? true;
      const docxTemplate: NovelDocxTemplate =
        args.docxTemplate ?? deps.config.export.docx.template ?? "default";

      const preflightEnabled = args.preflight ?? deps.config.export.preflight.enabled ?? false;
      const preflightChecks = args.preflightChecks ??
        deps.config.export.preflight.checks ?? [
          "index",
          "continuity",
          "foreshadowing",
          "structure",
          "arc",
          "pacing",
        ];
      const preflightFailOn =
        args.preflightFailOn ?? deps.config.export.preflight.failOn ?? "error";

      const preflight = await runPreflight({
        projectRoot: deps.projectRoot,
        config: deps.config,
        rootDir,
        manuscriptDir: manuscriptDirName,
        enabled: preflightEnabled,
        checks: preflightChecks,
        failOn: preflightFailOn,
        context,
      });
      diagnostics.push(...preflight.diagnostics);

      const exportFormats = resolveExportFormats(
        args.format,
        deps.config.export.formats,
        diagnostics,
      );

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const preflightBlocked = preflight.summary?.blocked ?? false;
      const writeOutputFiles = writeFile && !preflightBlocked;

      let ordered = [...scan.entities.chapters];
      if (chapterOrder === "by_id") {
        ordered.sort((a, b) => a.chapter_id.localeCompare(b.chapter_id));
      } else if (chapterOrder === "by_timeline") {
        ordered.sort((a, b) =>
          sortByTimelineKey(
            { date: a.timeline?.date, start: a.timeline?.start, chapter_id: a.chapter_id },
            { date: b.timeline?.date, start: b.timeline?.start, chapter_id: b.chapter_id },
          ),
        );
      } else {
        const custom = args.customOrder ?? [];
        const byId = new Map(ordered.map((c) => [c.chapter_id, c]));
        const picked: typeof ordered = [];
        const missing: string[] = [];
        for (const id of custom) {
          const c = byId.get(id);
          if (c) picked.push(c);
          else missing.push(id);
        }
        if (missing.length > 0) {
          diagnostics.push({
            severity: "warn",
            code: "EXPORT_CUSTOM_ORDER_MISSING",
            message: `customOrder 中存在不存在章节: ${missing.join(", ")}`,
          });
        }
        const pickedSet = new Set(picked.map((c) => c.chapter_id));
        const rest = ordered
          .filter((c) => !pickedSet.has(c.chapter_id))
          .sort((a, b) => a.chapter_id.localeCompare(b.chapter_id));
        ordered = [...picked, ...rest];
      }

      const mergedMdParts: string[] = [];
      const titleById = new Map<string, string>();
      const chaptersForEpub: { id: string; title: string; markdown: string }[] = [];
      const chapterManifestEntries: NovelExportManifest["chapters"] = [];
      for (const chapter of ordered) {
        const abs = fromRelativePosixPath(rootDir, chapter.path);
        if (!existsSync(abs)) {
          diagnostics.push({
            severity: "error",
            code: "EXPORT_CHAPTER_MISSING_FILE",
            message: `章节文件不存在: ${chapter.path}`,
          });
          continue;
        }
        const content = readTextFileSync(abs, { encoding: deps.config.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: chapter.path,
          strict: false,
        });
        diagnostics.push(...parsed.diagnostics);

        const titleForHeading =
          chapter.title ??
          (typeof parsed.data.title === "string" ? parsed.data.title : chapter.chapter_id);
        titleById.set(chapter.chapter_id, titleForHeading);
        const bodyWithHeading = ensureChapterHeading(parsed.body, titleForHeading);

        const markdownFinal = includeFrontmatter
          ? parsed.hasFrontmatter
            ? buildFrontmatterFile(parsed.data as Record<string, unknown>, bodyWithHeading)
            : bodyWithHeading
          : bodyWithHeading;

        mergedMdParts.push(markdownFinal.trimEnd());
        chaptersForEpub.push({
          id: chapter.chapter_id,
          title: titleForHeading,
          markdown: markdownFinal,
        });
        chapterManifestEntries.push({
          chapter_id: chapter.chapter_id,
          path: chapter.path,
          title: titleForHeading,
          contentSha256: createSha256Hex(markdownFinal),
        });
      }

      const mergedMarkdown = `${mergedMdParts.join("\n\n---\n\n")}\n`;

      const chapterInfos = ordered.map((c) => ({
        chapter_id: c.chapter_id,
        title: titleById.get(c.chapter_id) ?? c.title,
        path: c.path,
      }));

      const baseName = slugifyTitle(title);
      const includesDocx = exportFormats.includes("docx");
      const outputs: Array<{ format: NovelExportFormat; outputPath?: string }> = [];
      const outputManifestEntries: NovelExportManifest["outputs"] = [];
      for (const format of exportFormats) {
        const fileExt =
          format === "docx"
            ? "docx"
            : format === "html"
              ? "html"
              : format === "epub"
                ? "epub"
                : "md";
        const outputPathAbs = path.join(outputDir, `${baseName}.${fileExt}`);
        const outputPathRel = toRelativePosixPath(rootDir, outputPathAbs);

        if (writeOutputFiles) {
          if (format === "md") {
            writeTextFile(outputPathAbs, mergedMarkdown, { mode: "always" });
            outputManifestEntries.push({
              format,
              outputPath: outputPathRel,
              contentSha256: createSha256Hex(mergedMarkdown),
            });
          } else if (format === "html") {
            const htmlBody = markdownToHtml(mergedMarkdown);
            const html = wrapHtmlDocument({
              title,
              bodyHtml: htmlBody,
              language: deps.config.language,
            });
            writeTextFile(outputPathAbs, html, { mode: "always" });
            outputManifestEntries.push({
              format,
              outputPath: outputPathRel,
              contentSha256: createSha256Hex(html),
            });
          } else if (format === "epub") {
            const bytes = chaptersToEpubBytes({
              title,
              language: deps.config.language,
              chapters: chaptersForEpub.map((c) => ({
                id: c.id,
                title: c.title,
                bodyHtml: markdownToHtml(c.markdown),
              })),
            });
            ensureDirForFile(outputPathAbs);
            await Bun.write(outputPathAbs, bytes);
            outputManifestEntries.push({
              format,
              outputPath: outputPathRel,
              contentSha256: createSha256HexFromBytes(bytes),
            });
          } else {
            const bytes = await markdownToDocxBytes(mergedMarkdown, {
              title,
              template: docxTemplate,
            });
            ensureDirForFile(outputPathAbs);
            await Bun.write(outputPathAbs, bytes);
            outputManifestEntries.push({
              format,
              outputPath: outputPathRel,
              contentSha256: createSha256HexFromBytes(bytes),
            });
          }
        }

        outputs.push({ format, outputPath: writeOutputFiles ? outputPathRel : undefined });
      }

      let manifestPath: string | undefined;
      if (writeOutputFiles) {
        const manifestPathAbs = path.join(outputDir, `${baseName}.manifest.json`);
        manifestPath = toRelativePosixPath(rootDir, manifestPathAbs);

        const manifest: NovelExportManifest = {
          version: 1,
          title,
          formats: exportFormats,
          chapterOrder,
          includeFrontmatter,
          docxTemplate: includesDocx ? docxTemplate : undefined,
          preflight: preflight.summary
            ? {
                enabled: preflight.summary.enabled,
                blocked: preflight.summary.blocked,
                failOn: preflight.summary.failOn,
                checks: [...preflight.summary.checks],
              }
            : undefined,
          chapters: chapterManifestEntries,
          outputs: outputManifestEntries,
        };

        writeTextFile(manifestPathAbs, `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: "always",
        });
      }

      const durationMs = Date.now() - startedAt;
      const nextSteps = preflightBlocked
        ? ["修复预检报告中的问题后重试：/novel-export"]
        : undefined;
      const resultJson: NovelExportResultJson =
        exportFormats.length <= 1
          ? ({
              version: 1,
              format: exportFormats[0] ?? "md",
              outputPath: outputs[0]?.outputPath,
              manifestPath,
              docxTemplate: includesDocx ? docxTemplate : undefined,
              chapters: chapterInfos,
              stats: { chapters: chapterInfos.length, durationMs },
              preflight: preflight.summary,
              nextSteps,
              diagnostics,
            } satisfies NovelExportResultJsonV1)
          : ({
              version: 2,
              formats: exportFormats,
              outputs,
              manifestPath,
              docxTemplate: includesDocx ? docxTemplate : undefined,
              chapters: chapterInfos,
              stats: { chapters: chapterInfos.length, durationMs },
              preflight: preflight.summary,
              nextSteps,
              diagnostics,
            } satisfies NovelExportResultJsonV2);

      return formatToolMarkdownOutput({
        summaryLines:
          exportFormats.length <= 1
            ? [
                `format: ${exportFormats[0] ?? "md"}`,
                `chapters: ${chapterInfos.length}`,
                ...(includesDocx ? [`docxTemplate: ${docxTemplate}`] : []),
                `preflight: ${preflightEnabled ? (preflightBlocked ? "blocked" : "passed") : "disabled"}`,
                `outputPath: ${writeOutputFiles ? (outputs[0]?.outputPath ?? "(none)") : "(blocked/dry)"}`,
                `manifestPath: ${manifestPath ?? "(none)"}`,
                `durationMs: ${durationMs}`,
              ]
            : [
                `formats: ${exportFormats.join(", ")}`,
                `chapters: ${chapterInfos.length}`,
                ...(includesDocx ? [`docxTemplate: ${docxTemplate}`] : []),
                `preflight: ${preflightEnabled ? (preflightBlocked ? "blocked" : "passed") : "disabled"}`,
                `outputs: ${
                  writeOutputFiles ? outputs.map((o) => o.outputPath).join(", ") : "(blocked/dry)"
                }`,
                `manifestPath: ${manifestPath ?? "(none)"}`,
                `durationMs: ${durationMs}`,
              ],
        resultJson,
        diagnostics,
      });
    },
  });
}

function slugifyTitle(title: string): string {
  const safe = title
    .trim()
    .replace(/[<>:"/\\\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe.length > 0 ? safe : "novel";
}

function resolveExportFormats(
  requested: NovelExportFormat | undefined,
  configFormats: NovelExportFormat[] | undefined,
  diagnostics: Diagnostic[],
): NovelExportFormat[] {
  if (requested) return [requested];

  const list = Array.isArray(configFormats) ? configFormats : [];
  const deduped: NovelExportFormat[] = [];
  const seen = new Set<NovelExportFormat>();
  for (const fmt of list) {
    if (!fmt) continue;
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    deduped.push(fmt);
  }

  if (deduped.length === 0) {
    diagnostics.push({
      severity: "warn",
      code: "EXPORT_FORMATS_EMPTY",
      message: "config.export.formats 为空，已回退为 ['md']。",
    });
    return ["md"];
  }

  return deduped;
}

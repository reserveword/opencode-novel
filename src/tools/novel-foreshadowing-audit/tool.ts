import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { renderThreadsReportMd } from "../novel-index/render";
import { loadOrScan } from "../novel-scan/scan";
import { renderForeshadowingAuditMd } from "./render";
import type {
  NovelForeshadowingArgs,
  NovelForeshadowingResultJson,
  ThreadAuditItem,
} from "./types";

type ThreadMeta = {
  opened_in?: string;
  expected_close_by?: string;
  closed_in?: string | null;
  close_plan?: string;
  status?: string;
  type?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function readThreadMeta(
  rootDir: string,
  threadPath: string,
  diagnostics: Diagnostic[],
  encoding: NovelConfig["encoding"],
): ThreadMeta {
  const abs = fromRelativePosixPath(rootDir, threadPath);
  if (!existsSync(abs)) return {};
  const content = readTextFileSync(abs, { encoding });
  const parsed = parseFrontmatter<Record<string, unknown>>(content, {
    file: threadPath,
    strict: false,
  });
  diagnostics.push(...parsed.diagnostics);

  const data = parsed.data;
  const openedObj =
    data.opened_in && typeof data.opened_in === "object"
      ? (data.opened_in as Record<string, unknown>)
      : undefined;
  const opened_in =
    openedObj && typeof openedObj.chapter_id === "string" ? openedObj.chapter_id : undefined;

  const expected_close_by =
    typeof data.expected_close_by === "string" ? data.expected_close_by : undefined;
  const closed_in =
    typeof data.closed_in === "string" || data.closed_in === null
      ? (data.closed_in as string | null)
      : undefined;
  const close_plan = typeof data.close_plan === "string" ? data.close_plan : undefined;
  const status = typeof data.status === "string" ? data.status : undefined;
  const type = typeof data.type === "string" ? data.type : undefined;

  return { opened_in, expected_close_by, closed_in, close_plan, status, type };
}

export function createNovelForeshadowingAuditTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Audit threads (foreshadowing/promises) and produce FORESHADOWING_AUDIT.md and THREADS_REPORT.md.",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      writeReport: tool.schema.boolean().optional(),
      strictMode: tool.schema.boolean().optional(),
    },
    async execute(args: NovelForeshadowingArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const writeReport = args.writeReport ?? true;
      const strictMode = args.strictMode ?? deps.config.continuity.strictMode ?? false;
      const repro = "/novel-foreshadowing-audit";

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      const threadsEnabled = deps.config.threads.enabled ?? true;
      if (!threadsEnabled) {
        diagnostics.push({
          severity: "info",
          code: "THREADS_DISABLED",
          message: "threads.enabled=false，已跳过线程审计。",
        });
      }

      const chapterIdSet = new Set(scan.entities.chapters.map((c) => c.chapter_id));
      const chapterOrder = new Map(
        [...scan.entities.chapters]
          .map((chapter) => chapter.chapter_id)
          .sort((a, b) => a.localeCompare(b))
          .map((chapterId, index) => [chapterId, index] as const),
      );

      const items: ThreadAuditItem[] = [];
      const threadsReport = threadsEnabled
        ? scan.entities.threads.map((t) => {
            const meta = readThreadMeta(rootDir, t.path, diagnostics, deps.config.encoding);
            return { ...t, ...meta };
          })
        : [];

      for (const t of threadsReport) {
        const issues: ThreadAuditItem["issues"] = [];

        const status = t.status ?? "open";
        const closePlan = (t as unknown as ThreadMeta).close_plan;

        const staleDaysWarn = deps.config.threads.staleDaysWarn ?? 0;
        if ((status === "open" || status === "in_progress") && staleDaysWarn > 0) {
          try {
            const abs = fromRelativePosixPath(rootDir, t.path);
            const stats = statSync(abs);
            const days = Math.floor((Date.now() - stats.mtimeMs) / DAY_MS);
            if (days >= staleDaysWarn) {
              issues.push({
                severity: "warn",
                code: "THREAD_STALE",
                message: `线程可能已 ${days} 天未更新（阈值=${staleDaysWarn} 天）。`,
                evidence: [{ file: t.path }],
                suggestedFix:
                  "检查该线程是否需要推进/关闭；更新 thread 卡，或在相关章节补充 threads_advanced/threads_closed。",
                repro,
              });
            }
          } catch {
            // ignore
          }
        }

        if (
          (status === "open" || status === "in_progress") &&
          (!closePlan || closePlan.trim().length === 0)
        ) {
          const severity = deps.config.threads.requireClosePlan
            ? strictMode
              ? "error"
              : "warn"
            : "info";
          issues.push({
            severity,
            code: "THREAD_NO_CLOSE_PLAN",
            message: "线程未回收但缺少 close_plan。",
            evidence: [{ file: t.path }],
            suggestedFix:
              "补充 close_plan（如何回收/在哪些章节回收），并在对应章节标注 threads_closed。",
            repro,
          });
        }

        if (status === "closed" && !t.closed_in) {
          issues.push({
            severity: "warn",
            code: "THREAD_CLOSED_MISSING_CLOSED_IN",
            message: "线程 status=closed 但 closed_in 为空。",
            evidence: [{ file: t.path }],
            suggestedFix: "在 thread 卡中补充 closed_in=回收章节，并在该章节标注 threads_closed。",
            repro,
          });
        }

        if (typeof t.expected_close_by === "string" && !chapterIdSet.has(t.expected_close_by)) {
          issues.push({
            severity: "warn",
            code: "THREAD_EXPECTED_CLOSE_INVALID",
            message: `expected_close_by 指向不存在章节: ${t.expected_close_by}`,
            evidence: [{ file: t.path }],
            suggestedFix:
              "修正 expected_close_by 为存在的 chapter_id，或留空并改用 close_plan 说明回收计划。",
            repro,
          });
        }

        if (typeof t.closed_in === "string" && !chapterIdSet.has(t.closed_in)) {
          issues.push({
            severity: strictMode ? "error" : "warn",
            code: "THREAD_CLOSED_IN_INVALID",
            message: `closed_in 指向不存在章节: ${t.closed_in}`,
            evidence: [{ file: t.path }],
            suggestedFix:
              "修正 closed_in 为存在的 chapter_id；必要时把 status 改回 open/in_progress 并补 close_plan。",
            repro,
          });
        }

        const suggestedNextStep = issues.some((i) => i.code === "THREAD_NO_CLOSE_PLAN")
          ? "补充 close_plan，并在合适章节标注 threads_closed。"
          : issues.some((i) => i.code.includes("INVALID"))
            ? "修正 thread 卡的章节引用（opened_in/expected_close_by/closed_in）。"
            : undefined;

        items.push({
          thread_id: t.thread_id,
          path: t.path,
          type: t.type,
          status: t.status,
          opened_in: t.opened_in,
          expected_close_by: t.expected_close_by,
          closed_in: t.closed_in ?? null,
          issues,
          suggestedNextStep,
        });
      }

      items.sort((a, b) => {
        const aExpectedOrder =
          typeof a.expected_close_by === "string"
            ? chapterOrder.get(a.expected_close_by)
            : undefined;
        const bExpectedOrder =
          typeof b.expected_close_by === "string"
            ? chapterOrder.get(b.expected_close_by)
            : undefined;

        if (aExpectedOrder !== undefined && bExpectedOrder !== undefined) {
          const chapterCmp = aExpectedOrder - bExpectedOrder;
          if (chapterCmp !== 0) return chapterCmp;
        }

        if ((aExpectedOrder !== undefined) !== (bExpectedOrder !== undefined)) {
          return aExpectedOrder !== undefined ? -1 : 1;
        }

        const expectedCmp = (a.expected_close_by ?? "").localeCompare(b.expected_close_by ?? "");
        if (expectedCmp !== 0) return expectedCmp;

        return a.thread_id.localeCompare(b.thread_id);
      });

      const counts = { open: 0, in_progress: 0, closed: 0, abandoned: 0 };
      for (const item of items) {
        const s = (item.status ?? "open") as keyof typeof counts;
        if (counts[s] !== undefined) counts[s] += 1;
      }

      const auditPathAbs = path.join(outputDir, "FORESHADOWING_AUDIT.md");
      const auditPathRel = toRelativePosixPath(rootDir, auditPathAbs);
      const threadsReportPathAbs = path.join(outputDir, "THREADS_REPORT.md");
      const threadsReportPathRel = toRelativePosixPath(rootDir, threadsReportPathAbs);

      if (writeReport) {
        writeTextFile(auditPathAbs, renderForeshadowingAuditMd({ items, stats: counts }), {
          mode: "if-changed",
        });
        writeTextFile(threadsReportPathAbs, renderThreadsReportMd({ threads: threadsReport }), {
          mode: "if-changed",
        });
      }

      let hasWarnOrError = false;
      for (const item of items) {
        for (const issue of item.issues) {
          if (issue.severity === "error" || issue.severity === "warn") {
            hasWarnOrError = true;
            break;
          }
        }
        if (hasWarnOrError) break;
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelForeshadowingResultJson = {
        version: 1,
        reportPath: writeReport ? auditPathRel : undefined,
        stats: { ...counts, durationMs },
        items,
        nextSteps: hasWarnOrError
          ? [
              "修复 FORESHADOWING_AUDIT.md 中的问题后重新运行：/novel-foreshadowing-audit",
              "/novel-export（修复后导出）",
            ]
          : ["/novel-export（导出）"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `open: ${counts.open}`,
          `in_progress: ${counts.in_progress}`,
          `closed: ${counts.closed}`,
          `abandoned: ${counts.abandoned}`,
          `durationMs: ${durationMs}`,
          `reportPath: ${writeReport ? auditPathRel : "(dry)"}`,
          `threadsReportPath: ${writeReport ? threadsReportPathRel : "(dry)"}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NovelConfig } from "../../config/schema";
import type { Diagnostic, DiagnosticEvidence } from "../../shared/errors/diagnostics";
import { fromRelativePosixPath, toRelativePosixPath } from "../../shared/fs/paths";
import { readTextFileSync } from "../../shared/fs/read";
import { writeTextFile } from "../../shared/fs/write";
import { parseFrontmatter } from "../../shared/markdown/frontmatter";
import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { formatToolMarkdownOutput } from "../../shared/tool-output";
import { loadOrScan } from "../novel-scan/scan";
import { renderContinuityReportMd } from "./render";
import type {
  ContinuityFinding,
  ContinuitySeverity,
  NovelContinuityArgs,
  NovelContinuityResultJson,
} from "./types";

type RuleContext = {
  encoding: NovelConfig["encoding"];
  scan: ReturnType<typeof loadOrScan>;
  chaptersById: Array<{
    chapter_id: string;
    path: string;
    timeline?: { date?: string; start?: string; end?: string; location?: string };
    characters?: string[];
    threads_opened?: string[];
    threads_advanced?: string[];
    threads_closed?: string[];
    pov?: string;
  }>;
  strictMode: boolean;
  evidence: (file: string, excerpt?: string) => DiagnosticEvidence;
  chapterIdOrder: Map<string, number>;
  bibleRuleIds: Set<string>;
};

type Rule = {
  id: string;
  defaultSeverity: ContinuitySeverity;
  run: (ctx: RuleContext) => ContinuityFinding[];
};

function severityRank(severity: ContinuitySeverity): number {
  if (severity === "error") return 0;
  if (severity === "warn") return 1;
  return 2;
}

function parseTimeToMinutes(time: string): number | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function parseChapterInterval(chapter: {
  timeline?: { date?: string; start?: string; end?: string };
}): { startMs?: number; endMs?: number; errors: string[] } {
  const errors: string[] = [];
  const date = chapter.timeline?.date;
  const start = chapter.timeline?.start;
  const end = chapter.timeline?.end;

  const hasAny = Boolean(date || start || end);
  if (!hasAny) return { errors };

  let baseDateMs: number | undefined;
  if (date) {
    const parsed = Date.parse(date);
    if (!Number.isFinite(parsed)) {
      errors.push(`无法解析 date: ${date}`);
    } else {
      baseDateMs = parsed;
    }
  }

  const startMin = start ? parseTimeToMinutes(start) : null;
  const endMin = end ? parseTimeToMinutes(end) : null;
  if (start && startMin === null) errors.push(`无法解析 start: ${start}`);
  if (end && endMin === null) errors.push(`无法解析 end: ${end}`);

  if (baseDateMs !== undefined && startMin !== null) {
    const startMs = baseDateMs + startMin * 60 * 1000;
    const endMs = endMin !== null ? baseDateMs + endMin * 60 * 1000 : undefined;
    return { startMs, endMs, errors };
  }

  return { errors };
}

function loadBibleRuleIds(rootDir: string, config: NovelConfig): Set<string> {
  const derived = path.join(rootDir, config.index.outputDir, "BIBLE_SUMMARY.md");
  if (!existsSync(derived)) return new Set();
  const text = readFileSync(derived, "utf8");
  const ids = new Set<string>();
  for (const match of text.matchAll(/\b(R-[0-9]{3,}|R-[A-Z]+-[0-9]{1,})\b/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function applyRuleConfig(options: {
  config: NovelConfig;
  strictMode: boolean;
  findings: ContinuityFinding[];
}): ContinuityFinding[] {
  const disabled = new Set(options.config.disabled_rules ?? []);
  const ruleConfigById = new Map(
    (options.config.continuity.rules ?? []).map((r) => [r.id, r] as const),
  );

  return options.findings
    .filter((f) => !disabled.has(f.ruleId))
    .map((f) => {
      const rc = ruleConfigById.get(f.ruleId);
      if (rc && rc.enabled === false) {
        return null;
      }
      const severity = rc?.severity ?? f.severity;
      const normalized = options.strictMode && severity === "warn" ? "error" : severity;
      return { ...f, severity: normalized as ContinuitySeverity };
    })
    .filter(Boolean) as ContinuityFinding[];
}

const RULES: Rule[] = [
  {
    id: "CONT_TIME_REVERSE",
    defaultSeverity: "error",
    run(ctx) {
      const findings: ContinuityFinding[] = [];
      for (const chapter of ctx.chaptersById) {
        const interval = parseChapterInterval(chapter);
        if (
          interval.startMs !== undefined &&
          interval.endMs !== undefined &&
          interval.startMs > interval.endMs
        ) {
          findings.push({
            ruleId: "CONT_TIME_REVERSE",
            severity: "error",
            message: `timeline.start > timeline.end (${chapter.chapter_id})`,
            evidence: [ctx.evidence(chapter.path)],
            suggestedFix: "修正该章 frontmatter.timeline.start/end，确保 start <= end。",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_TIME_PARSE",
    defaultSeverity: "warn",
    run(ctx) {
      const findings: ContinuityFinding[] = [];
      for (const chapter of ctx.chaptersById) {
        const interval = parseChapterInterval(chapter);
        for (const err of interval.errors) {
          findings.push({
            ruleId: "CONT_TIME_PARSE",
            severity: "warn",
            message: `${err} (${chapter.chapter_id})`,
            evidence: [ctx.evidence(chapter.path)],
            suggestedFix: "按 ISO 日期与 HH:MM 时间格式填写 timeline 字段。",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_REF_CHARACTER_UNDEFINED",
    defaultSeverity: "warn",
    run(ctx) {
      const defined = new Set(ctx.scan.entities.characters.map((c) => c.id));
      const findings: ContinuityFinding[] = [];
      for (const chapter of ctx.chaptersById) {
        for (const charId of chapter.characters ?? []) {
          if (!defined.has(charId)) {
            findings.push({
              ruleId: "CONT_REF_CHARACTER_UNDEFINED",
              severity: ctx.strictMode ? "error" : "warn",
              message: `章节引用未定义角色: ${charId} (${chapter.chapter_id})`,
              evidence: [ctx.evidence(chapter.path)],
              suggestedFix: `创建 manuscript/characters/${charId}.md 或从 chapters/${chapter.chapter_id}.md 中移除该引用。`,
            });
          }
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_REF_THREAD_UNDEFINED",
    defaultSeverity: "warn",
    run(ctx) {
      const defined = new Set(ctx.scan.entities.threads.map((t) => t.thread_id));
      const findings: ContinuityFinding[] = [];
      for (const chapter of ctx.chaptersById) {
        const threadIds = [
          ...(chapter.threads_opened ?? []),
          ...(chapter.threads_advanced ?? []),
          ...(chapter.threads_closed ?? []),
        ];
        for (const threadId of threadIds) {
          if (!defined.has(threadId)) {
            findings.push({
              ruleId: "CONT_REF_THREAD_UNDEFINED",
              severity: "warn",
              message: `章节引用未定义线程: ${threadId} (${chapter.chapter_id})`,
              evidence: [ctx.evidence(chapter.path)],
              suggestedFix: `创建 manuscript/threads/${threadId}.md 或从 chapters/${chapter.chapter_id}.md 中移除该引用。`,
            });
          }
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_REF_LOCATION_UNDEFINED",
    defaultSeverity: "warn",
    run(ctx) {
      const defined = new Set(ctx.scan.entities.locations.map((l) => l.id));
      const findings: ContinuityFinding[] = [];
      for (const chapter of ctx.chaptersById) {
        const locationId = chapter.timeline?.location;
        if (locationId && !defined.has(locationId)) {
          findings.push({
            ruleId: "CONT_REF_LOCATION_UNDEFINED",
            severity: "warn",
            message: `timeline.location 引用未定义地点: ${locationId} (${chapter.chapter_id})`,
            evidence: [ctx.evidence(chapter.path)],
            suggestedFix: `创建 manuscript/locations/${locationId}.md 或更新 timeline.location。`,
          });
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_THREAD_STATUS_MISMATCH",
    defaultSeverity: "warn",
    run(ctx) {
      const findings: ContinuityFinding[] = [];
      const chapterIdSet = new Set(ctx.chaptersById.map((c) => c.chapter_id));

      for (const thread of ctx.scan.entities.threads) {
        const abs = fromRelativePosixPath(ctx.scan.rootDir, thread.path);
        if (!existsSync(abs)) continue;
        const content = readTextFileSync(abs, { encoding: ctx.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: thread.path,
          strict: false,
        });
        const data = parsed.data;

        const status = typeof data.status === "string" ? data.status : thread.status;
        const closed_in = typeof data.closed_in === "string" ? data.closed_in : null;

        if (status === "closed" && !closed_in) {
          findings.push({
            ruleId: "CONT_THREAD_STATUS_MISMATCH",
            severity: "warn",
            message: `thread.status=closed 但 closed_in 为空: ${thread.thread_id}`,
            evidence: [ctx.evidence(thread.path)],
            suggestedFix: "在 thread 卡中补充 closed_in（回收章节）。",
          });
        }
        if (closed_in && !chapterIdSet.has(closed_in)) {
          findings.push({
            ruleId: "CONT_THREAD_STATUS_MISMATCH",
            severity: ctx.strictMode ? "error" : "warn",
            message: `thread.closed_in 指向不存在章节: ${thread.thread_id} -> ${closed_in}`,
            evidence: [ctx.evidence(thread.path)],
            suggestedFix: "修正 closed_in 引用为有效 chapter_id。",
          });
        }
      }

      return findings;
    },
  },
  {
    id: "CONT_THREAD_CLOSE_BEFORE_OPEN",
    defaultSeverity: "error",
    run(ctx) {
      const findings: ContinuityFinding[] = [];
      for (const thread of ctx.scan.entities.threads) {
        const abs = fromRelativePosixPath(ctx.scan.rootDir, thread.path);
        if (!existsSync(abs)) continue;
        const content = readTextFileSync(abs, { encoding: ctx.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: thread.path,
          strict: false,
        });
        const data = parsed.data;

        const opened =
          data.opened_in && typeof data.opened_in === "object"
            ? (data.opened_in as Record<string, unknown>).chapter_id
            : undefined;
        const openedIn = typeof opened === "string" ? opened : undefined;
        const closedIn = typeof data.closed_in === "string" ? data.closed_in : undefined;

        if (!openedIn || !closedIn) continue;
        const openedIndex = ctx.chapterIdOrder.get(openedIn);
        const closedIndex = ctx.chapterIdOrder.get(closedIn);
        if (openedIndex === undefined || closedIndex === undefined) continue;
        if (closedIndex < openedIndex) {
          findings.push({
            ruleId: "CONT_THREAD_CLOSE_BEFORE_OPEN",
            severity: "error",
            message: `线程回收早于提出: ${thread.thread_id} (opened_in=${openedIn}, closed_in=${closedIn})`,
            evidence: [ctx.evidence(thread.path)],
            suggestedFix: "调整 opened_in/closed_in，或修正章节顺序/ID。",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "CONT_BIBLE_RULE_VIOLATION",
    defaultSeverity: "info",
    run(ctx) {
      const findings: ContinuityFinding[] = [];
      if (ctx.bibleRuleIds.size === 0) return findings;

      for (const chapter of ctx.chaptersById) {
        const abs = fromRelativePosixPath(ctx.scan.rootDir, chapter.path);
        if (!existsSync(abs)) continue;
        const content = readTextFileSync(abs, { encoding: ctx.encoding });
        const parsed = parseFrontmatter<Record<string, unknown>>(content, {
          file: chapter.path,
          strict: false,
        });
        const body = parsed.body;

        for (const match of body.matchAll(/\b(R-[0-9]{3,}|R-[A-Z]+-[0-9]{1,})\b/g)) {
          const id = match[1];
          if (!ctx.bibleRuleIds.has(id)) {
            findings.push({
              ruleId: "CONT_BIBLE_RULE_VIOLATION",
              severity: "info",
              message: `正文引用了不存在的规则条款: ${id} (${chapter.chapter_id})`,
              evidence: [
                ctx.evidence(
                  chapter.path,
                  body.slice(
                    Math.max(0, match.index ?? 0),
                    Math.min(body.length, (match.index ?? 0) + 80),
                  ),
                ),
              ],
              suggestedFix: "在 manuscript/bible/rules.md 中补充该规则编号，或修正正文引用。",
            });
          }
        }
      }
      return findings;
    },
  },
];

export function createNovelContinuityCheckTool(deps: {
  projectRoot: string;
  config: NovelConfig;
}): ToolDefinition {
  return tool({
    description:
      "Run continuity rules and produce CONTINUITY_REPORT.md (deterministic findings ordering).",
    args: {
      rootDir: tool.schema.string().optional(),
      manuscriptDir: tool.schema.string().optional(),
      outputDir: tool.schema.string().optional(),
      scope: tool.schema
        .union([
          tool.schema.object({ kind: tool.schema.literal("all") }),
          tool.schema.object({
            kind: tool.schema.literal("chapter"),
            chapter_id: tool.schema.string(),
          }),
        ])
        .optional(),
      strictMode: tool.schema.boolean().optional(),
      writeReport: tool.schema.boolean().optional(),
    },
    async execute(args: NovelContinuityArgs) {
      const startedAt = Date.now();
      const diagnostics: Diagnostic[] = [];

      const rootDir = path.resolve(args.rootDir ?? deps.projectRoot);
      const manuscriptDirName = args.manuscriptDir ?? deps.config.manuscriptDir;
      const outputDir = path.isAbsolute(args.outputDir ?? "")
        ? (args.outputDir as string)
        : path.resolve(path.join(rootDir, args.outputDir ?? deps.config.index.outputDir));
      const strictMode = args.strictMode ?? deps.config.continuity.strictMode ?? false;
      const writeReport = args.writeReport ?? true;

      const scan = loadOrScan({
        projectRoot: deps.projectRoot,
        config: deps.config,
        args: { rootDir, manuscriptDir: manuscriptDirName, mode: "incremental", writeCache: true },
      });
      diagnostics.push(...scan.diagnostics);

      let chaptersById = [...scan.entities.chapters].sort((a, b) =>
        a.chapter_id.localeCompare(b.chapter_id),
      );
      if (args.scope && args.scope.kind === "chapter") {
        const targetChapterId = args.scope.chapter_id;
        chaptersById = chaptersById.filter((c) => c.chapter_id === targetChapterId);
      }

      const chapterIdOrder = new Map<string, number>();
      for (let i = 0; i < chaptersById.length; i += 1) {
        chapterIdOrder.set(chaptersById[i].chapter_id, i);
      }

      const bibleRuleIds = loadBibleRuleIds(rootDir, deps.config);

      const ctx: RuleContext = {
        encoding: deps.config.encoding,
        scan,
        chaptersById,
        strictMode,
        evidence: (file, excerpt) => ({
          file,
          excerpt: excerpt ? excerpt.slice(0, 200) : undefined,
        }),
        chapterIdOrder,
        bibleRuleIds,
      };

      const findingsRaw: ContinuityFinding[] = [];
      if (deps.config.continuity.enabled !== false) {
        for (const rule of RULES) {
          // skip overlap rule when not full scope
          if (rule.id === "CONT_TIME_OVERLAP_SAME_CHAR") {
            continue;
          }
          try {
            const f = rule
              .run(ctx)
              .map((x) => ({ ...x, severity: x.severity ?? rule.defaultSeverity }));
            findingsRaw.push(...f);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diagnostics.push({
              severity: "error",
              code: "CONT_RULE_CRASH",
              message: `规则执行失败: ${rule.id} (${message})`,
            });
          }
        }
      }

      let findings = applyRuleConfig({ config: deps.config, strictMode, findings: findingsRaw });

      // Implement overlap rule only for all-scope
      if ((!args.scope || args.scope.kind === "all") && deps.config.continuity.enabled !== false) {
        const overlapFindings: ContinuityFinding[] = [];
        const intervalsByChar = new Map<
          string,
          Array<{
            startMs: number;
            endMs: number;
            chapter_id: string;
            path: string;
            location?: string;
          }>
        >();

        for (const chapter of scan.entities.chapters) {
          const interval = parseChapterInterval(chapter);
          if (!interval.startMs || !interval.endMs) continue;
          for (const charId of chapter.characters ?? []) {
            const list = intervalsByChar.get(charId) ?? [];
            list.push({
              startMs: interval.startMs,
              endMs: interval.endMs,
              chapter_id: chapter.chapter_id,
              path: chapter.path,
              location: chapter.timeline?.location,
            });
            intervalsByChar.set(charId, list);
          }
        }

        for (const [charId, list] of intervalsByChar.entries()) {
          const sorted = [...list].sort(
            (a, b) => a.startMs - b.startMs || a.chapter_id.localeCompare(b.chapter_id),
          );
          for (let i = 0; i < sorted.length; i += 1) {
            for (let j = i + 1; j < sorted.length; j += 1) {
              const a = sorted[i];
              const b = sorted[j];
              if (b.startMs >= a.endMs) break;
              const differentChapter = a.chapter_id !== b.chapter_id;
              const differentLocation = a.location && b.location && a.location !== b.location;
              if (differentChapter && differentLocation) {
                overlapFindings.push({
                  ruleId: "CONT_TIME_OVERLAP_SAME_CHAR",
                  severity: strictMode ? "error" : "warn",
                  message: `角色 ${charId} 在重叠时间出现在不同地点: ${a.chapter_id}(${a.location}) vs ${b.chapter_id}(${b.location})`,
                  evidence: [{ file: a.path }, { file: b.path }],
                  suggestedFix: "调整时间线/地点，或拆分为不同角色视角，避免并行矛盾。",
                });
              }
            }
          }
        }

        findings.push(
          ...applyRuleConfig({ config: deps.config, strictMode, findings: overlapFindings }),
        );
      }

      // POV policy: simple check (global styleGuide.pov vs chapter.pov)
      if (deps.config.styleGuide.pov) {
        for (const chapter of chaptersById) {
          if (chapter.pov && chapter.pov !== deps.config.styleGuide.pov) {
            findings.push({
              ruleId: "CONT_POV_POLICY_VIOLATION",
              severity: strictMode ? "error" : "warn",
              message: `章节 pov 与全局 pov 不一致: ${chapter.pov} != ${deps.config.styleGuide.pov} (${chapter.chapter_id})`,
              evidence: [{ file: chapter.path }],
              suggestedFix: "统一该章 pov 或调整全局 styleGuide.pov。",
            });
          }
        }
      }

      findings = findings.sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          a.ruleId.localeCompare(b.ruleId) ||
          a.message.localeCompare(b.message) ||
          (a.evidence[0]?.file ?? "").localeCompare(b.evidence[0]?.file ?? ""),
      );

      const repro = "/novel-continuity-check --scope=all";
      findings = findings.map((f) => ({ ...f, repro }));

      const errors = findings.filter((f) => f.severity === "error").length;
      const warns = findings.filter((f) => f.severity === "warn").length;
      const infos = findings.filter((f) => f.severity === "info").length;

      const reportPathAbs = path.join(outputDir, "CONTINUITY_REPORT.md");
      const reportPathRel = toRelativePosixPath(rootDir, reportPathAbs);
      if (writeReport) {
        writeTextFile(
          reportPathAbs,
          renderContinuityReportMd({ stats: { errors, warns, infos }, findings }),
          { mode: "if-changed" },
        );
      }

      const durationMs = Date.now() - startedAt;
      const resultJson: NovelContinuityResultJson = {
        version: 1,
        reportPath: writeReport ? reportPathRel : undefined,
        stats: { errors, warns, infos, durationMs },
        findings,
        nextSteps:
          errors > 0 || warns > 0
            ? [
                "修复 CONTINUITY_REPORT.md 中的问题后重新运行：/novel-continuity-check",
                "/novel-export（修复后导出）",
              ]
            : ["/novel-export（导出）"],
        diagnostics,
      };

      return formatToolMarkdownOutput({
        summaryLines: [
          `errors: ${errors}`,
          `warns: ${warns}`,
          `infos: ${infos}`,
          `durationMs: ${durationMs}`,
          `reportPath: ${writeReport ? reportPathRel : "(dry)"}`,
        ],
        resultJson,
        diagnostics,
      });
    },
  });
}

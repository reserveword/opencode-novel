import { z } from "zod";
import { TEXT_ENCODINGS } from "../shared/strings/text-encoding";

const NovelLanguageSchema = z.enum(["zh", "en"]).default("zh");
const NovelEncodingSchema = z.enum(TEXT_ENCODINGS).default("auto");

const StyleGuideSchema = z
  .object({
    pov: z.enum(["first", "third_limited", "third_omniscient", "multi"]).optional(),
    tense: z.enum(["past", "present", "mixed"]).optional(),
    tone: z.string().optional(),
    taboos: z.array(z.string()).default([]),
    rating: z.string().default("G"),
    lexicon: z
      .object({
        preferred: z.array(z.string()).default([]),
        avoid: z.array(z.string()).default([]),
      })
      .default({ preferred: [], avoid: [] }),
    checks: z
      .object({
        catchphrase: z
          .object({
            maxCount: z.number().int().nonnegative().default(10),
            reportMissing: z.boolean().default(true),
          })
          .default({ maxCount: 10, reportMissing: true }),
      })
      .default({
        catchphrase: { maxCount: 10, reportMissing: true },
      }),
  })
  .default({
    taboos: [],
    rating: "G",
    lexicon: { preferred: [], avoid: [] },
    checks: {
      catchphrase: { maxCount: 10, reportMissing: true },
    },
  });

const NamingSchema = z
  .object({
    chapterIdPattern: z.string().default("^ch\\d{4}$"),
    threadIdPattern: z.string().default("^th-[\\w\\u4e00-\\u9fa5-]+$"),
    characterIdPattern: z.string().default("^char-[\\w\\u4e00-\\u9fa5-]+$"),
    factionIdPattern: z.string().default("^fac-[\\w\\u4e00-\\u9fa5-]+$"),
    locationIdPattern: z.string().default("^loc-[\\w\\u4e00-\\u9fa5-]+$"),
    dateFormat: z.string().default("ISO"),
  })
  .default({
    chapterIdPattern: "^ch\\d{4}$",
    threadIdPattern: "^th-[\\w\\u4e00-\\u9fa5-]+$",
    characterIdPattern: "^char-[\\w\\u4e00-\\u9fa5-]+$",
    factionIdPattern: "^fac-[\\w\\u4e00-\\u9fa5-]+$",
    locationIdPattern: "^loc-[\\w\\u4e00-\\u9fa5-]+$",
    dateFormat: "ISO",
  });

const IndexSchema = z
  .object({
    outputDir: z.string().default(".opencode/novel"),
    cacheDir: z.string().default(".opencode/novel/cache"),
    stableSortLocale: z.string().default("zh-CN"),
    writeDerivedFiles: z.boolean().default(true),
  })
  .default({
    outputDir: ".opencode/novel",
    cacheDir: ".opencode/novel/cache",
    stableSortLocale: "zh-CN",
    writeDerivedFiles: true,
  });

const ContinuityRuleConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  severity: z.enum(["error", "warn", "info"]).default("warn"),
  params: z.record(z.string(), z.unknown()).optional(),
});

const ContinuitySchema = z
  .object({
    enabled: z.boolean().default(true),
    rules: z.array(ContinuityRuleConfigSchema).default([]),
    strictMode: z.boolean().default(false),
  })
  .default({ enabled: true, rules: [], strictMode: false });

const ThreadsSchema = z
  .object({
    enabled: z.boolean().default(true),
    requireClosePlan: z.boolean().default(true),
    staleDaysWarn: z.number().int().nonnegative().default(30),
  })
  .default({ enabled: true, requireClosePlan: true, staleDaysWarn: 30 });

const StructureSchema = z
  .object({
    enabled: z.boolean().default(true),
    required_beats: z
      .array(z.string().min(1))
      .default(["setup", "inciting_incident", "midpoint", "climax", "resolution"]),
    min_coverage: z.number().min(0).max(1).default(0.8),
  })
  .default({
    enabled: true,
    required_beats: ["setup", "inciting_incident", "midpoint", "climax", "resolution"],
    min_coverage: 0.8,
  });

const SceneSchema = z
  .object({
    enabled: z.boolean().default(true),
    required_fields: z
      .array(z.enum(["scene_id", "objective", "conflict", "outcome", "hook"]))
      .default(["scene_id", "objective", "conflict", "outcome"]),
  })
  .default({
    enabled: true,
    required_fields: ["scene_id", "objective", "conflict", "outcome"],
  });

const NovelExportFormatSchema = z.enum(["md", "html", "epub", "docx"]);
const NovelChapterOrderSchema = z.enum(["by_id", "by_timeline", "custom"]);
const ExportDocxTemplateSchema = z.enum(["default", "manuscript"]);
const ExportDocxSchema = z
  .object({
    template: ExportDocxTemplateSchema.default("default"),
  })
  .default({ template: "default" });

const ExportPreflightCheckSchema = z.enum([
  "index",
  "continuity",
  "foreshadowing",
  "style",
  "structure",
  "scene",
  "arc",
  "pacing",
]);
const ExportPreflightSchema = z
  .object({
    enabled: z.boolean().default(false),
    checks: z
      .array(ExportPreflightCheckSchema)
      .default(["index", "continuity", "foreshadowing", "structure", "arc", "pacing"]),
    failOn: z.enum(["error", "warn"]).default("error"),
  })
  .default({
    enabled: false,
    checks: ["index", "continuity", "foreshadowing", "structure", "arc", "pacing"],
    failOn: "error",
  });

const ExportSchema = z
  .object({
    formats: z.array(NovelExportFormatSchema).default(["md"]),
    chapterOrder: NovelChapterOrderSchema.default("by_id"),
    includeFrontmatter: z.boolean().default(false),
    outputDir: z.string().default("export"),
    docx: ExportDocxSchema,
    preflight: ExportPreflightSchema,
  })
  .default({
    formats: ["md"],
    chapterOrder: "by_id",
    includeFrontmatter: false,
    outputDir: "export",
    docx: { template: "default" },
    preflight: {
      enabled: false,
      checks: ["index", "continuity", "foreshadowing"],
      failOn: "error",
    },
  });

const ContextPackSchema = z
  .object({
    maxChars: z.number().int().positive().default(12000),
    include: z
      .object({
        bible: z.boolean().default(true),
        characters: z.boolean().default(true),
        openThreads: z.boolean().default(true),
        lastChapters: z.number().int().nonnegative().default(3),
      })
      .default({
        bible: true,
        characters: true,
        openThreads: true,
        lastChapters: 3,
      }),
    redaction: z
      .object({
        enabled: z.boolean().default(false),
        patterns: z.array(z.string()).default([]),
      })
      .default({ enabled: false, patterns: [] }),
  })
  .default({
    maxChars: 12000,
    include: { bible: true, characters: true, openThreads: true, lastChapters: 3 },
    redaction: { enabled: false, patterns: [] },
  });

const PermissionEffectSchema = z.enum(["allow", "ask", "deny"]);

const AgentOverrideSchema = z
  .object({
    model: z.string().optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    steps: z.number().int().positive().optional(),
    prompt: z.string().optional(),
    prompt_append: z.string().optional(),
    // Shorthand (`"ask"`) or a resource pattern map (`{ "git push *": "ask" }`).
    permission: z
      .record(
        z.string(),
        z.union([PermissionEffectSchema, z.record(z.string(), PermissionEffectSchema)]),
      )
      .optional(),
  })
  .passthrough();

const ChapterDetectionPatternSchema = z.object({
  id: z.string(),
  regex: z.string(),
  flags: z.string().optional(),
});

const ImportSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultMode: z.enum(["copy", "analyze"]).default("copy"),
    includeGlobs: z.array(z.string()).default(["**/*.md", "**/*.txt"]),
    excludeGlobs: z
      .array(z.string())
      .default([
        ".git/**",
        ".opencode/**",
        "manuscript/**",
        "node_modules/**",
        "dist/**",
        "build/**",
        "out/**",
        ".cache/**",
      ]),
    chapterDetection: z
      .object({
        mode: z.literal("heading_heuristic").default("heading_heuristic"),
        patterns: z.array(ChapterDetectionPatternSchema).default([
          {
            id: "zh_chapter",
            regex: "^\\s*#*\\s*第([0-9一二三四五六七八九十百千万两〇零]+)\\s*章(.*)$",
            flags: "i",
          },
          {
            id: "en_chapter",
            regex: "^\\s*#*\\s*Chapter\\s+(\\d+)\\s*[:：-]?\\s*(.*)$",
            flags: "i",
          },
        ]),
        enableLooseH1AfterFirstMatch: z.boolean().default(true),
      })
      .default({
        mode: "heading_heuristic",
        patterns: [
          {
            id: "zh_chapter",
            regex: "^\\s*#*\\s*第([0-9一二三四五六七八九十百千万两〇零]+)\\s*章(.*)$",
            flags: "i",
          },
          {
            id: "en_chapter",
            regex: "^\\s*#*\\s*Chapter\\s+(\\d+)\\s*[:：-]?\\s*(.*)$",
            flags: "i",
          },
        ],
        enableLooseH1AfterFirstMatch: true,
      }),
    chapterId: z
      .object({
        scheme: z.literal("from_heading").default("from_heading"),
        prefix: z.string().default("ch"),
        pad: z.number().int().positive().default(4),
        specialPrefix: z.string().default("sp"),
      })
      .default({ scheme: "from_heading", prefix: "ch", pad: 4, specialPrefix: "sp" }),
    multiChapterFiles: z.literal("split").default("split"),
    manuscriptExistsPolicy: z.literal("merge").default("merge"),
  })
  .default({
    enabled: true,
    defaultMode: "copy",
    includeGlobs: ["**/*.md", "**/*.txt"],
    excludeGlobs: [
      ".git/**",
      ".opencode/**",
      "manuscript/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "out/**",
      ".cache/**",
    ],
    chapterDetection: {
      mode: "heading_heuristic",
      patterns: [
        {
          id: "zh_chapter",
          regex: "^\\s*#*\\s*第([0-9一二三四五六七八九十百千万两〇零]+)\\s*章(.*)$",
          flags: "i",
        },
        {
          id: "en_chapter",
          regex: "^\\s*#*\\s*Chapter\\s+(\\d+)\\s*[:：-]?\\s*(.*)$",
          flags: "i",
        },
      ],
      enableLooseH1AfterFirstMatch: true,
    },
    chapterId: { scheme: "from_heading", prefix: "ch", pad: 4, specialPrefix: "sp" },
    multiChapterFiles: "split",
    manuscriptExistsPolicy: "merge",
  });

const CompatSchema = z
  .object({
    export_slashcommand_tool: z.boolean().default(true),
    export_skill_tool: z.boolean().default(true),
  })
  .default({
    export_slashcommand_tool: true,
    export_skill_tool: true,
  });

export const NovelConfigSchema = z
  .object({
    projectRoot: z.string().optional(),
    manuscriptDir: z.string().default("manuscript"),
    language: NovelLanguageSchema,
    encoding: NovelEncodingSchema,

    styleGuide: StyleGuideSchema,
    naming: NamingSchema,
    frontmatter: z.record(z.string(), z.unknown()).optional(),

    index: IndexSchema,
    continuity: ContinuitySchema,
    threads: ThreadsSchema,
    structure: StructureSchema,
    scene: SceneSchema,
    export: ExportSchema,
    contextPack: ContextPackSchema,

    agents_enabled: z.boolean().default(true),
    agent_name_prefix: z.string().default("novel-"),
    agents_preset: z.enum(["core", "full"]).default("core"),
    agents_primary: z.array(z.string()).default(["novel"]),
    disabled_agents: z.array(z.string()).default([]),
    agents_force_override: z.boolean().default(false),
    agents: z.record(z.string(), AgentOverrideSchema).default({}),

    customTemplatesDir: z.string().optional(),
    customRulesDir: z.string().optional(),
    skills: z.record(z.string(), z.unknown()).optional(),

    import: ImportSchema,
    compat: CompatSchema,

    disabled_commands: z.array(z.string()).default([]),
    disabled_skills: z.array(z.string()).default([]),
    disabled_rules: z.array(z.string()).default([]),
  })
  .passthrough();

export type NovelConfig = z.infer<typeof NovelConfigSchema>;

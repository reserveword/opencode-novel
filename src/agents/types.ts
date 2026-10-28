export type NovelCoreAgentBaseName = "novel" | "muse" | "editor" | "sentinel";

export type NovelExpertAgentBaseName =
  | "oracle"
  | "entity-extractor"
  | "character-expert"
  | "faction-relations"
  | "worldbible-keeper"
  | "timeline-keeper"
  | "continuity-sentinel"
  | "foreshadowing-unresolved"
  | "flaw-finder"
  | "continuation-expert"
  | "polish-expert"
  | "summary-expert";

export type NovelAgentBaseName = NovelCoreAgentBaseName | NovelExpertAgentBaseName;

export type NovelAgentMode = "primary" | "subagent" | "all";

export type NovelPermissionEffect = "allow" | "ask" | "deny";

/** OpenCode 2.x ordered permission rule (`action`/`resource`/`effect`). */
export type NovelPermissionRule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: NovelPermissionEffect;
};

/**
 * OpenCode 2.x generation settings applied through the session `context` hook.
 *
 * Keys match `GenerationOptionsFields`, which is the typed part of the hook's
 * `event.options`.
 */
export type NovelAgentSampling = {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
};

/**
 * Plugin-neutral agent definition.
 *
 * Mirrors the OpenCode 2.x `Agent.Info` fields the plugin manages: `mode`,
 * `description`, `system`, `model`, `permissions`, `steps` and `sampling`.
 * Sampling settings reach the model request through the session `context` hook.
 */
export type NovelAgentDefinition = {
  readonly mode: NovelAgentMode;
  readonly description?: string;
  readonly system?: string;
  readonly model?: string;
  readonly permissions?: readonly NovelPermissionRule[];
  /** Generation settings applied per model request through the `context` hook. */
  readonly sampling?: NovelAgentSampling;
  /** Maximum model steps before OpenCode forces a text-only answer. */
  readonly steps?: number;
};

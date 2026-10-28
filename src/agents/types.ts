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
 * Plugin-neutral agent definition.
 *
 * Matches the OpenCode 2.x `Agent.Info` fields the plugin manages: `mode`,
 * `description`, `system`, `model` and `permissions`. OpenCode 2.x does not send
 * per-agent `temperature`/`top_p` to providers, so those fields are gone.
 */
export type NovelAgentDefinition = {
  readonly mode: NovelAgentMode;
  readonly description?: string;
  readonly system?: string;
  readonly model?: string;
  readonly permissions?: readonly NovelPermissionRule[];
};

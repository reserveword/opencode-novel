import { createNovelEditorAgent } from "./editor";
import {
  createNovelCharacterExpertAgent,
  createNovelContinuationExpertAgent,
  createNovelContinuitySentinelAgent,
  createNovelEntityExtractorAgent,
  createNovelFactionRelationsAgent,
  createNovelFlawFinderAgent,
  createNovelForeshadowingUnresolvedAgent,
  createNovelOracleAgent,
  createNovelPolishExpertAgent,
  createNovelSummaryExpertAgent,
  createNovelTimelineKeeperAgent,
  createNovelWorldbibleKeeperAgent,
} from "./experts";
import { createNovelMuseAgent } from "./muse";
import { createNovelAgent } from "./novel";
import { createNovelSentinelAgent } from "./sentinel";
import type { NovelAgentBaseName, NovelAgentDefinition } from "./types";

export type { NovelAgentBaseName, NovelAgentDefinition } from "./types";

export function createNovelAgents(options: {
  preset: "core" | "full";
  model: string;
}): Record<NovelAgentBaseName, NovelAgentDefinition> {
  const core = {
    novel: createNovelAgent(options.model),
    muse: createNovelMuseAgent(options.model),
    editor: createNovelEditorAgent(options.model),
    sentinel: createNovelSentinelAgent(options.model),
  } satisfies Record<string, NovelAgentDefinition>;

  if (options.preset === "core") {
    return core as Record<NovelAgentBaseName, NovelAgentDefinition>;
  }

  return {
    ...core,
    oracle: createNovelOracleAgent(options.model),
    "entity-extractor": createNovelEntityExtractorAgent(options.model),
    "character-expert": createNovelCharacterExpertAgent(options.model),
    "faction-relations": createNovelFactionRelationsAgent(options.model),
    "worldbible-keeper": createNovelWorldbibleKeeperAgent(options.model),
    "timeline-keeper": createNovelTimelineKeeperAgent(options.model),
    "continuity-sentinel": createNovelContinuitySentinelAgent(options.model),
    "foreshadowing-unresolved": createNovelForeshadowingUnresolvedAgent(options.model),
    "flaw-finder": createNovelFlawFinderAgent(options.model),
    "continuation-expert": createNovelContinuationExpertAgent(options.model),
    "polish-expert": createNovelPolishExpertAgent(options.model),
    "summary-expert": createNovelSummaryExpertAgent(options.model),
  } as Record<NovelAgentBaseName, NovelAgentDefinition>;
}

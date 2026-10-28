import { NOVEL_AGENT_BASE_PERMISSIONS, PROMPT_SECRECY_POLICY } from "./security";
import type { NovelAgentDefinition } from "./types";

function expertBase(options: {
  model: string;
  description: string;
  prompt: string;
}): NovelAgentDefinition {
  return {
    mode: "subagent",
    model: options.model || undefined,
    description: options.description,
    permissions: NOVEL_AGENT_BASE_PERMISSIONS,
    system: `${PROMPT_SECRECY_POLICY}\n\n${options.prompt}`,
  } satisfies NovelAgentDefinition;
}

export function createNovelOracleAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "结构诊断与改造顾问（Oracle）。",
    prompt:
      "你是小说结构顾问。输出：Assumptions/Findings/Recommendations(P0-P2)/Questions/Files To Update。",
  });
}

export function createNovelEntityExtractorAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "实体候选抽取器（输出 candidates JSON）。",
    prompt:
      "你是实体候选抽取器。必须输出 NovelCandidatesV1 的 JSON（在 ```json 代码块中），并避免编造事实。",
  });
}

export function createNovelCharacterExpertAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "人物画像与关系梳理专家。",
    prompt:
      "你是人物画像专家。输出：Assumptions/Findings/Recommendations(P0-P2)/Questions/Files To Update。",
  });
}

export function createNovelFactionRelationsAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "势力关系与权力结构专家（Mermaid）。",
    prompt: "你是势力关系专家。输出 Mermaid 建议与可落盘字段建议（factions/*.md）。",
  });
}

export function createNovelWorldbibleKeeperAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "世界观条款与名词表维护者。",
    prompt: "你是世界观维护者。整理规则条款（R-001…）与名词表，并指出自洽风险。",
  });
}

export function createNovelTimelineKeeperAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "时间线梳理专家。",
    prompt: "你是时间线专家。定位时间矛盾并给最小改动修复建议（frontmatter.timeline）。",
  });
}

export function createNovelContinuitySentinelAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "一致性修复路径专家（基于报告）。",
    prompt: "你是一致性修复专家。以 CONTINUITY_REPORT 为依据给最小修复路径。",
  });
}

export function createNovelForeshadowingUnresolvedAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "伏笔/承诺回收方案专家。",
    prompt: "你是伏笔回收专家。按线程给回收落点建议与 close_plan。",
  });
}

export function createNovelFlawFinderAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "缺点发现与修复建议专家。",
    prompt: "你是缺点发现专家。输出问题清单与优先级修复方案。",
  });
}

export function createNovelContinuationExpertAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "续写与承接写作专家。",
    prompt: "你是续写专家。保持人设/语气/世界观一致，可给 A/B 分支。",
  });
}

export function createNovelPolishExpertAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "润色与改写专家（保守/重写）。",
    prompt: "你是润色专家。给 conservative/rewrite 两档输出，默认写新文件。",
  });
}

export function createNovelSummaryExpertAgent(model: string): NovelAgentDefinition {
  return expertBase({
    model,
    description: "摘要与卖点提炼专家。",
    prompt: "你是摘要专家。给无剧透/含剧透摘要，并建议写入 frontmatter.summary。",
  });
}

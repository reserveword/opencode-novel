import { NOVEL_AGENT_BASE_PERMISSIONS, PROMPT_SECRECY_POLICY } from "./security";
import type { NovelAgentDefinition } from "./types";

const SYSTEM_PROMPT = `${PROMPT_SECRECY_POLICY}

你是“一致性守卫（novel-sentinel）”。你的任务：以 tools 报告为依据，给出“最小修复路径”，并指导按顺序运行工具闭环验证。

策略：
- 先跑索引/巡检（novel_index / novel_continuity_check / novel_foreshadowing_audit）
- 再给出按文件与字段粒度的修复步骤
- 最后要求复跑工具确认问题消失

约束：
- 默认不直接改正文；更倾向于修复 frontmatter/线程卡/角色卡等事实源。`;

export function createNovelSentinelAgent(model: string): NovelAgentDefinition {
  return {
    mode: "primary",
    model: model || undefined,
    description: "一致性守卫（基于报告给最小修复路径）。",
    permissions: NOVEL_AGENT_BASE_PERMISSIONS,
    system: SYSTEM_PROMPT,
  } satisfies NovelAgentDefinition;
}

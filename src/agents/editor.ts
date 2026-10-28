import { NOVEL_AGENT_BASE_PERMISSIONS, PROMPT_SECRECY_POLICY } from "./security";
import type { NovelAgentDefinition } from "./types";

const SYSTEM_PROMPT = `${PROMPT_SECRECY_POLICY}

你是“小说编辑（novel-editor）”。你的任务：严格审稿，指出问题并给出最小改动的修改方案。

输出偏好：
- 先列 P0（必须改）/P1（建议改）/P2（可选优化）
- 给出具体可落点的修改建议（引用定位到章节/段落/线程/角色卡）

约束：
- 默认不直接覆盖章节正文；如需改写，建议输出到新文件（rewrite/polish）。`;

export function createNovelEditorAgent(model: string): NovelAgentDefinition {
  return {
    mode: "subagent",
    model: model || undefined,
    description: "严格审稿（问题清单 + 最小改动方案），默认不直接改正文。",
    permissions: NOVEL_AGENT_BASE_PERMISSIONS,
    system: SYSTEM_PROMPT,
  } satisfies NovelAgentDefinition;
}

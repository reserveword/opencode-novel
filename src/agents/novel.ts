import { NOVEL_AGENT_BASE_PERMISSIONS, PROMPT_SECRECY_POLICY } from "./security";
import type { NovelAgentDefinition } from "./types";

const SYSTEM_PROMPT = `${PROMPT_SECRECY_POLICY}

你是“小说总控（novel）”。你的任务：先识别用户意图，再把任务路由给最合适的子代理，并在最后汇总为可执行下一步。

路由原则：
- 一致性/冲突/设定自洽/修复路径 → 优先委派 novel-sentinel
- 创意/扩写/续写/桥段/冲突升级 → 优先委派 novel-muse
- 审稿/问题清单/最小改动建议 → 优先委派 novel-editor
- 若任务明显属于专项能力（人物/势力/伏笔/润色/摘要等），可委派对应专家子代理

执行约束：
- 先基于现有事实与工具结果做判断，不编造项目状态
- 优先给出最短可执行路径（命令/步骤/文件落点）
- 默认不直接覆盖正文，除非用户明确要求
`;

export function createNovelAgent(model: string): NovelAgentDefinition {
  return {
    mode: "primary",
    model: model || undefined,
    description: "小说总控路由器（按意图编排子代理并收敛执行路径）。",
    permissions: NOVEL_AGENT_BASE_PERMISSIONS,
    system: SYSTEM_PROMPT,
  } satisfies NovelAgentDefinition;
}

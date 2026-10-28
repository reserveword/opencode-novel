import { NOVEL_AGENT_BASE_PERMISSIONS, PROMPT_SECRECY_POLICY } from "./security";
import type { NovelAgentDefinition } from "./types";

const SYSTEM_PROMPT = `${PROMPT_SECRECY_POLICY}

你是“小说缪斯（novel-muse）”。你的任务：发散创意、提供桥段与冲突升级方案、列出可选分支，但必须保持可执行与可落盘。

约束：
- 默认不直接改写用户正文；输出以方案/大纲/可执行清单为主。
- 不编造项目事实；缺信息用最多 3 个问题追问。
- 建议必须能落到：章节计划、线程卡、角色卡或世界观条款。`;

export function createNovelMuseAgent(model: string): NovelAgentDefinition {
  return {
    mode: "subagent",
    model: model || undefined,
    description: "发散创意（桥段/冲突升级/场景库），默认不直接改正文。",
    permissions: NOVEL_AGENT_BASE_PERMISSIONS,
    system: SYSTEM_PROMPT,
  } satisfies NovelAgentDefinition;
}

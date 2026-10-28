import { Model, type Plugin } from "@opencode/plugin";
import { createNovelAgents } from "../agents";
import type {
  NovelAgentDefinition,
  NovelPermissionEffect,
  NovelPermissionRule,
} from "../agents/types";
import type { NovelConfig } from "../config/schema";

/** OpenCode 2.x plugin context type derived from the public `Plugin.define` helper. */
type OpenCodePluginContext = Parameters<Plugin.Plugin["setup"]>[0];

/** V1 permission keys that map to a different OpenCode 2.x permission action. */
const PERMISSION_ACTION_ALIASES: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
};

/** V1 per-agent sampling fields that OpenCode 2.x no longer forwards to providers. */
const UNSUPPORTED_OVERRIDE_FIELDS = ["temperature", "top_p", "maxTokens", "max_steps"] as const;

type AgentOverride = Record<string, unknown>;

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Map a base agent name onto its configured (possibly prefixed) id. */
function resolveAgentName(baseName: string, prefix: string): string {
  if (baseName.toLowerCase() === "novel") return "novel";
  return `${prefix}${baseName}`;
}

/** Map a V1 permission effect value onto an OpenCode 2.x effect. */
function normalizeEffect(value: unknown): NovelPermissionEffect | undefined {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return undefined;
}

/** Convert V1 `permission` / `tools` overrides into OpenCode 2.x permission rules. */
function toPermissionRules(override: AgentOverride): NovelPermissionRule[] {
  const rules: NovelPermissionRule[] = [];

  if (isRecord(override.tools)) {
    for (const [toolName, allowed] of Object.entries(override.tools)) {
      if (typeof allowed !== "boolean") continue;
      rules.push({
        action: toolName,
        resource: "*",
        effect: allowed ? "allow" : "deny",
      });
    }
  }

  if (isRecord(override.permission)) {
    for (const [action, effect] of Object.entries(override.permission)) {
      const normalized = normalizeEffect(effect);
      if (!normalized) continue;
      rules.push({
        action: PERMISSION_ACTION_ALIASES[action] ?? action,
        resource: "*",
        effect: normalized,
      });
    }
  }

  return rules;
}

/** Parse a `provider/model#variant` reference, returning undefined when malformed. */
function parseModelRef(value: string): Model.Ref | undefined {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.includes("/")) return undefined;
  try {
    return Model.Ref.parse(trimmed) as Model.Ref;
  } catch {
    return undefined;
  }
}

/** Apply `novel.jsonc` per-agent overrides onto a generated agent definition. */
function applyAgentOverride(
  base: NovelAgentDefinition,
  override: AgentOverride | undefined,
): NovelAgentDefinition {
  if (!override) return base;

  const unsupported = UNSUPPORTED_OVERRIDE_FIELDS.filter((field) => override[field] !== undefined);
  if (unsupported.length > 0) {
    console.warn(
      `[opencode-novel] agent override field(s) ignored on OpenCode 2.x: ${unsupported.join(", ")}`,
    );
  }

  const modelValue = typeof override.model === "string" ? override.model : base.model;
  const variant = typeof override.variant === "string" ? override.variant : undefined;
  const model = modelValue
    ? variant && !modelValue.includes("#")
      ? `${modelValue}#${variant}`
      : modelValue
    : base.model;

  const prompt = typeof override.prompt === "string" ? override.prompt : base.system;
  const promptAppend = typeof override.prompt_append === "string" ? override.prompt_append : "";
  const system = promptAppend ? (prompt ? `${prompt}\n\n${promptAppend}` : promptAppend) : prompt;

  return {
    ...base,
    model,
    system,
    permissions: [...(base.permissions ?? []), ...toPermissionRules(override)],
  };
}

/**
 * Register the built-in novel agents through the OpenCode 2.x agent transform.
 *
 * OpenCode 2.x has no mutable config hook; agents are declared by writing into
 * the agent registry. `update` creates the agent when the id is absent and
 * edits it otherwise.
 */
export async function registerNovelAgents(
  ctx: OpenCodePluginContext,
  pluginConfig: NovelConfig,
): Promise<void> {
  if (pluginConfig.agents_enabled === false) return;

  const prefix = pluginConfig.agent_name_prefix ?? "novel-";
  const preset = pluginConfig.agents_preset ?? "core";
  const disabled = new Set((pluginConfig.disabled_agents ?? []).map((s) => s.toLowerCase()));
  const primaryAgents = pluginConfig.agents_primary ?? [];
  const primary =
    primaryAgents.length > 0
      ? new Set(primaryAgents.map((s) => s.toLowerCase()))
      : new Set(["novel"]);
  const forceOverride = pluginConfig.agents_force_override ?? false;

  const agents = createNovelAgents({ preset, model: "" });

  await ctx.agent.transform((editor) => {
    for (const [baseName, agentDefinition] of Object.entries(agents)) {
      const name = resolveAgentName(baseName, prefix);
      const baseNameLower = baseName.toLowerCase();
      const nameLower = name.toLowerCase();
      if (disabled.has(baseNameLower) || disabled.has(nameLower)) continue;
      if (!forceOverride && editor.get(name)) continue;

      const overrideValue = pluginConfig.agents?.[name];
      const override = isRecord(overrideValue) ? overrideValue : undefined;
      const finalAgent = applyAgentOverride(agentDefinition, override);
      const mode = primary.has(baseNameLower) || primary.has(nameLower) ? "primary" : "subagent";
      const modelRef = finalAgent.model ? parseModelRef(finalAgent.model) : undefined;

      if (finalAgent.model && !modelRef) {
        console.warn(
          `[opencode-novel] ignoring invalid model reference for agent "${name}": ${finalAgent.model}`,
        );
      }

      editor.update(name, (agent) => {
        agent.mode = mode;
        if (finalAgent.description) agent.description = finalAgent.description;
        if (finalAgent.system) agent.system = finalAgent.system;
        if (modelRef) {
          agent.model = modelRef;
        }
        if (finalAgent.permissions && finalAgent.permissions.length > 0) {
          agent.permissions = [...agent.permissions, ...finalAgent.permissions];
        }
      });
    }
  });
}

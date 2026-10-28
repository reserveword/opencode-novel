import { Model, type Plugin } from "@opencode/plugin";
import { createNovelAgents } from "../agents";
import type {
  NovelAgentDefinition,
  NovelAgentSampling,
  NovelPermissionEffect,
  NovelPermissionRule,
} from "../agents/types";
import type { NovelConfig } from "../config/schema";

/** OpenCode 2.x plugin context type derived from the public `Plugin.define` helper. */
export type OpenCodePluginContext = Parameters<Plugin.Plugin["setup"]>[0];

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

/** Parse a permission effect value. */
function toPermissionEffect(value: unknown): NovelPermissionEffect | undefined {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return undefined;
}

/**
 * Convert a `permission` override into OpenCode 2.x permission rules.
 *
 * Each entry is either a shorthand effect (`"ask"`) applied to every resource,
 * or a pattern map (`{ "git push *": "ask" }`). Pattern order is preserved so
 * later entries still win.
 */
export function toPermissionRules(override: AgentOverride): NovelPermissionRule[] {
  const rules: NovelPermissionRule[] = [];
  if (!isRecord(override.permission)) return rules;

  for (const [action, value] of Object.entries(override.permission)) {
    const shorthand = toPermissionEffect(value);
    if (shorthand) {
      rules.push({ action, resource: "*", effect: shorthand });
      continue;
    }

    if (!isRecord(value)) continue;
    for (const [resource, effect] of Object.entries(value)) {
      const parsedEffect = toPermissionEffect(effect);
      if (!parsedEffect) continue;
      rules.push({ action, resource, effect: parsedEffect });
    }
  }

  return rules;
}

/** Read a finite number, ignoring anything else. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract sampling parameters as OpenCode 2.x generation settings.
 *
 * The session `context` hook takes camelCase generation keys (`topP`,
 * `maxTokens`).
 */
export function toSamplingOptions(override: AgentOverride): NovelAgentSampling | undefined {
  const sampling: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  } = {};

  const temperature = numberOrUndefined(override.temperature);
  if (temperature !== undefined) sampling.temperature = temperature;

  const topP = numberOrUndefined(override.topP);
  if (topP !== undefined) sampling.topP = topP;

  const maxTokens = numberOrUndefined(override.maxTokens);
  if (maxTokens !== undefined) sampling.maxTokens = maxTokens;

  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

/**
 * Apply a managed agent's sampling settings to a session `context` event.
 *
 * `event.options` is the pre-dispatch surface OpenCode 2.x documents for
 * generation settings, so this is what makes per-agent `temperature` / `topP` /
 * `maxTokens` effective. Agents the plugin does not manage are left alone.
 */
export function applySamplingOptions(
  agentID: string,
  options: Record<string, unknown>,
  sampling: ReadonlyMap<string, NovelAgentSampling>,
): boolean {
  const agentSampling = sampling.get(agentID);
  if (!agentSampling) return false;

  if (agentSampling.temperature !== undefined) {
    options.temperature = agentSampling.temperature;
  }
  if (agentSampling.topP !== undefined) {
    options.topP = agentSampling.topP;
  }
  if (agentSampling.maxTokens !== undefined) {
    options.maxTokens = agentSampling.maxTokens;
  }

  return true;
}

/** Read a positive integer, ignoring anything else. */
function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
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
export function applyAgentOverride(
  base: NovelAgentDefinition,
  override: AgentOverride | undefined,
): NovelAgentDefinition {
  if (!override) return base;

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

  const sampling = toSamplingOptions(override);
  const steps = positiveIntegerOrUndefined(override.steps) ?? base.steps;

  return {
    ...base,
    model,
    system,
    steps,
    permissions: [...(base.permissions ?? []), ...toPermissionRules(override)],
    sampling: sampling ?? base.sampling,
  };
}

/**
 * Register the built-in novel agents through the OpenCode 2.x agent transform.
 *
 * OpenCode 2.x has no mutable config hook; agents are declared by writing into
 * the agent registry. `update` creates the agent when the id is absent and
 * edits it otherwise.
 *
 * Per-agent sampling is registered as a session `context` hook, which is the
 * surface OpenCode 2.x documents for generation settings. The hook reads the
 * registry the transform fills, so it only ever touches agents this plugin
 * manages.
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
  const sampling = new Map<string, NovelAgentSampling>();

  await ctx.session.hook("context", (event) => {
    applySamplingOptions(String(event.agent), event.options, sampling);
  });

  await ctx.agent.transform((editor) => {
    sampling.clear();

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
        if (finalAgent.steps !== undefined) {
          agent.steps = finalAgent.steps;
        }
        if (finalAgent.permissions && finalAgent.permissions.length > 0) {
          agent.permissions = [...agent.permissions, ...finalAgent.permissions];
        }
      });

      if (finalAgent.sampling) {
        sampling.set(name, finalAgent.sampling);
      }
    }
  });
}

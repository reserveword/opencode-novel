import { describe, expect, it } from "bun:test";
import type { NovelAgentDefinition, NovelAgentSampling } from "../agents/types";
import type { NovelConfig } from "../config/schema";
import {
  applyAgentOverride,
  applySamplingOptions,
  type OpenCodePluginContext,
  registerNovelAgents,
  toPermissionRules,
  toSamplingOptions,
} from "./agents-handler";

const base: NovelAgentDefinition = {
  mode: "primary",
  description: "base agent",
  system: "base prompt",
  permissions: [{ action: "edit", resource: "*", effect: "deny" }],
};

describe("toPermissionRules", () => {
  it("keeps shorthand permission effects as wildcard rules", () => {
    expect(toPermissionRules({ permission: { edit: "deny", webfetch: "ask" } })).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "ask" },
    ]);
  });

  it("expands nested pattern maps into ordered resource rules", () => {
    expect(
      toPermissionRules({
        permission: {
          shell: { "*": "ask", "git status *": "allow", "rm -rf *": "deny" },
          subagent: { "*": "deny", "novel-*": "allow" },
        },
      }),
    ).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status *", effect: "allow" },
      { action: "shell", resource: "rm -rf *", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "novel-*", effect: "allow" },
    ]);
  });

  it("drops unknown effects and non-object values", () => {
    expect(
      toPermissionRules({
        permission: {
          edit: "maybe",
          shell: { "*": "sometimes", "ls *": "allow" },
          webfetch: 42,
        },
      }),
    ).toEqual([{ action: "shell", resource: "ls *", effect: "allow" }]);
  });

  it("returns no rules without a usable permission override", () => {
    expect(toPermissionRules({})).toEqual([]);
    expect(toPermissionRules({ permission: { shell: true } })).toEqual([]);
  });

  it("ignores the removed tools map", () => {
    expect(toPermissionRules({ tools: { read: false, shell: true } })).toEqual([]);
  });
});

describe("toSamplingOptions", () => {
  it("maps config keys onto generation settings", () => {
    expect(toSamplingOptions({ temperature: 0.4, topP: 0.9, maxTokens: 4096 })).toEqual({
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 4096,
    });
  });

  it("ignores the removed top_p alias", () => {
    expect(toSamplingOptions({ top_p: 0.9 })).toBeUndefined();
    expect(toSamplingOptions({ top_p: 0.5, topP: 0.9 })).toEqual({ topP: 0.9 });
  });

  it("returns undefined when nothing usable is configured", () => {
    expect(toSamplingOptions({ temperature: "0.4", topP: Number.NaN })).toBeUndefined();
    expect(toSamplingOptions({})).toBeUndefined();
  });
});

describe("applySamplingOptions", () => {
  const sampling: ReadonlyMap<string, NovelAgentSampling> = new Map([
    ["novel", { temperature: 0.3, topP: 0.85, maxTokens: 1234 }],
  ]);

  it("writes generation settings into the context event options", () => {
    const options: Record<string, unknown> = {};

    expect(applySamplingOptions("novel", options, sampling)).toBe(true);
    expect(options).toEqual({ temperature: 0.3, topP: 0.85, maxTokens: 1234 });
  });

  it("leaves agents the plugin does not manage untouched", () => {
    const options: Record<string, unknown> = { temperature: 1 };

    expect(applySamplingOptions("build", options, sampling)).toBe(false);
    expect(options).toEqual({ temperature: 1 });
  });

  it("only writes the settings that are configured", () => {
    const options: Record<string, unknown> = {};
    const partial: ReadonlyMap<string, NovelAgentSampling> = new Map([
      ["novel-muse", { temperature: 0.9 }],
    ]);

    expect(applySamplingOptions("novel-muse", options, partial)).toBe(true);
    expect(options).toEqual({ temperature: 0.9 });
  });
});

describe("applyAgentOverride", () => {
  it("returns the base definition when no override is configured", () => {
    expect(applyAgentOverride(base, undefined)).toBe(base);
  });

  it("appends fine-grained rules after the built-in permissions", () => {
    const agent = applyAgentOverride(base, {
      permission: { shell: { "*": "ask", "git log *": "allow" } },
    });

    expect(agent.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git log *", effect: "allow" },
    ]);
  });

  it("carries sampling parameters and the step limit", () => {
    const agent = applyAgentOverride(base, {
      temperature: 0.2,
      topP: 0.8,
      maxTokens: 2048,
      steps: 6,
    });

    expect(agent.sampling).toEqual({ temperature: 0.2, topP: 0.8, maxTokens: 2048 });
    expect(agent.steps).toBe(6);
  });

  it("ignores the removed maxSteps alias", () => {
    expect(applyAgentOverride(base, { maxSteps: 9 }).steps).toBeUndefined();
  });

  it("ignores invalid step values", () => {
    expect(applyAgentOverride(base, { steps: 0 }).steps).toBeUndefined();
    expect(applyAgentOverride(base, { steps: 2.5 }).steps).toBeUndefined();
  });

  it("keeps prompt, model and sampling overrides together", () => {
    const agent = applyAgentOverride(base, {
      model: "openai/gpt-5",
      variant: "high",
      prompt_append: "extra",
      temperature: 0.7,
    });

    expect(agent.model).toBe("openai/gpt-5#high");
    expect(agent.system).toBe("base prompt\n\nextra");
    expect(agent.sampling).toEqual({ temperature: 0.7 });
  });
});

type ContextEvent = {
  agent: string;
  options: Record<string, unknown>;
};

type FakeAgent = {
  mode?: string;
  description?: string;
  system?: string;
  model?: unknown;
  steps?: number;
  permissions: { action: string; resource: string; effect: string }[];
};

/** Minimal plugin context double covering the two registration surfaces used here. */
function createFakeContext() {
  const hooks = new Map<string, (event: ContextEvent) => void>();
  const agents = new Map<string, FakeAgent>();
  let transform: ((editor: unknown) => void) | undefined;

  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: () => {},
    remove: (id: string) => {
      agents.delete(id);
    },
    update: (id: string, update: (agent: FakeAgent) => void) => {
      const agent: FakeAgent = agents.get(id) ?? { permissions: [] };
      update(agent);
      agents.set(id, agent);
    },
  };

  const ctx = {
    session: {
      hook: async (name: string, callback: (event: ContextEvent) => void) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        transform = callback;
      },
    },
  } as unknown as OpenCodePluginContext;

  return {
    ctx,
    hooks,
    agents,
    runTransform: () => transform?.(editor),
  };
}

const overrideConfig = {
  agents_enabled: true,
  agents_preset: "core",
  agents_primary: [],
  disabled_agents: [],
  agents: { novel: { temperature: 0.35, topP: 0.85, maxTokens: 1234 } },
} as unknown as NovelConfig;

describe("registerNovelAgents", () => {
  it("applies configured sampling through the session context hook", async () => {
    const { ctx, hooks, runTransform } = createFakeContext();

    await registerNovelAgents(ctx, overrideConfig);
    runTransform();

    const hook = hooks.get("context");
    expect(hook).toBeDefined();

    const options: Record<string, unknown> = {};
    hook?.({ agent: "novel", options });

    expect(options).toEqual({ temperature: 0.35, topP: 0.85, maxTokens: 1234 });
  });

  it("leaves agents outside the managed set untouched", async () => {
    const { ctx, hooks, runTransform } = createFakeContext();

    await registerNovelAgents(ctx, overrideConfig);
    runTransform();

    const options: Record<string, unknown> = { temperature: 1 };
    hooks.get("context")?.({ agent: "build", options });

    expect(options).toEqual({ temperature: 1 });
  });

  it("does not register the hook when agents are disabled", async () => {
    const { ctx, hooks } = createFakeContext();

    await registerNovelAgents(ctx, { ...overrideConfig, agents_enabled: false });

    expect(hooks.size).toBe(0);
  });
});

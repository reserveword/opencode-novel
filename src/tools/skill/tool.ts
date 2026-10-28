import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { discoverAllSkills } from "./loader";
import type { LoadedSkill } from "./types";

const PROTECTED_TEMPLATE_NOTICE = "Skill template body is internal and cannot be displayed.";

function formatSkillsList(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "# Available Skills\n\n(none)\n";
  const lines: string[] = ["# Available Skills", ""];
  for (const s of skills) {
    lines.push(`- **${s.name}**: ${s.definition.description ?? "(no description)"} (${s.scope})`);
  }
  lines.push("", `**Total**: ${skills.length}`);
  return lines.join("\n");
}

export function createSkillTool(options: {
  projectRoot: string;
  disabledSkills?: string[];
}): ToolDefinition {
  let cached: LoadedSkill[] | null = null;

  const getSkills = (): LoadedSkill[] => {
    if (cached) return cached;
    cached = discoverAllSkills({
      projectRoot: options.projectRoot,
      disabledSkills: options.disabledSkills,
    });
    return cached;
  };

  return tool({
    get description() {
      const skills = getSkills();
      return `Resolve a skill by name (metadata only; template protected).\n\n${formatSkillsList(skills)}`;
    },
    args: {
      name: tool.schema.string().describe("Skill name (e.g., 'novel-entity-extractor')"),
    },
    async execute(args: { name: string }, ctx?: { agent?: string }) {
      const skills = getSkills();
      const skill = skills.find((s) => s.name.toLowerCase() === args.name.toLowerCase());
      if (!skill) {
        return `${formatSkillsList(skills)}\n\nSkill "${args.name}" not found.`;
      }
      if (skill.definition.agent && ctx?.agent && skill.definition.agent !== ctx.agent) {
        throw new Error(`Skill "${skill.name}" is restricted to agent "${skill.definition.agent}"`);
      }
      return [
        `## Skill: ${skill.name}`,
        "",
        `**Description**: ${skill.definition.description ?? ""}`,
        `**Scope**: ${skill.scope}`,
        `**Template Visibility**: protected`,
        "",
        "## Notes",
        "",
        `- ${PROTECTED_TEMPLATE_NOTICE}`,
        "",
      ].join("\n");
    },
  });
}

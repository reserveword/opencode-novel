import { type ToolDefinition, tool } from "../../shared/plugin/tool";
import { discoverAllSkills } from "../skill/loader";
import { discoverAllCommands } from "./loader";
import type { CommandInfo } from "./types";

const PROTECTED_TEMPLATE_NOTICE = "Command template body is internal and cannot be displayed.";

function formatCommandList(
  items: Array<{ name: string; description?: string; scope: string; hint?: string }>,
): string {
  const lines: string[] = ["# Available Commands & Skills", ""];
  for (const item of items) {
    const hint = item.hint ? ` ${item.hint}` : "";
    lines.push(
      `- **/${item.name}${hint}**: ${item.description ?? "(no description)"} (${item.scope})`,
    );
  }
  lines.push("", `**Total**: ${items.length}`);
  return lines.join("\n");
}

async function formatLoadedCommand(cmd: CommandInfo, userMessage?: string): Promise<string> {
  const sections: string[] = [];
  sections.push(`# /${cmd.name} Command`, "");
  if (cmd.metadata.description) sections.push(`**Description**: ${cmd.metadata.description}`);
  if (cmd.metadata.argumentHint)
    sections.push(`**Usage**: /${cmd.name} ${cmd.metadata.argumentHint}`);
  if (userMessage) sections.push(`**Arguments**: ${userMessage}`);
  if (cmd.metadata.agent) sections.push(`**Agent**: ${cmd.metadata.agent}`);
  if (cmd.metadata.model) sections.push(`**Model**: ${cmd.metadata.model}`);
  if (cmd.metadata.subtask) sections.push(`**Subtask**: true`);
  sections.push(`**Scope**: ${cmd.scope}`);
  sections.push(`**Template Visibility**: protected`);
  sections.push("", "---", "", "## Run", "");
  sections.push(`Execute directly with: \`/${cmd.name}${userMessage ? ` ${userMessage}` : ""}\``);
  sections.push("", "## Notes", "", `- ${PROTECTED_TEMPLATE_NOTICE}`);
  sections.push("");
  return sections.join("\n");
}

export function createSlashcommandTool(options: {
  projectRoot: string;
  disabledCommands?: string[];
  disabledSkills?: string[];
}): ToolDefinition {
  let cachedCommands: CommandInfo[] | null = null;
  let cachedDescription: string | null = null;

  const getCommands = (): CommandInfo[] => {
    if (cachedCommands) return cachedCommands;
    cachedCommands = discoverAllCommands({
      projectRoot: options.projectRoot,
      disabledCommands: options.disabledCommands,
    });
    return cachedCommands;
  };

  const buildDescription = (): string => {
    const commands = getCommands();
    const skills = discoverAllSkills({
      projectRoot: options.projectRoot,
      disabledSkills: options.disabledSkills,
    });
    const items = [
      ...commands.map((c) => ({
        name: c.name,
        description: c.metadata.description,
        scope: c.scope,
        hint: c.metadata.argumentHint,
      })),
      ...skills.map((s) => ({
        name: s.name,
        description: s.definition.description,
        scope: s.scope,
        hint: s.definition.argumentHint,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    return `Load a command or skill by name.\n\n${formatCommandList(items)}`;
  };

  cachedDescription = buildDescription();

  return tool({
    get description() {
      return cachedDescription ?? buildDescription();
    },
    args: {
      command: tool.schema.string().describe("Slash command name (without leading /)"),
      user_message: tool.schema.string().optional().describe("Optional command arguments"),
    },
    async execute(args: { command: string; user_message?: string }) {
      const commands = getCommands();
      const skills = discoverAllSkills({
        projectRoot: options.projectRoot,
        disabledSkills: options.disabledSkills,
      });

      const all = [
        ...commands.map((c) => ({
          type: "command" as const,
          name: c.name,
          scope: c.scope,
          description: c.metadata.description,
          hint: c.metadata.argumentHint,
        })),
        ...skills.map((s) => ({
          type: "skill" as const,
          name: s.name,
          scope: s.scope,
          description: s.definition.description,
          hint: s.definition.argumentHint,
        })),
      ].sort((a, b) => a.name.localeCompare(b.name));

      const normalized = args.command.replace(/^\//, "").toLowerCase();

      const exactCommand = commands.find((c) => c.name.toLowerCase() === normalized);
      if (exactCommand) {
        return await formatLoadedCommand(exactCommand, args.user_message);
      }

      const exactSkill = skills.find((s) => s.name.toLowerCase() === normalized);
      if (exactSkill) {
        return [
          `# /${exactSkill.name} Skill`,
          "",
          `**Description**: ${exactSkill.definition.description ?? ""}`,
          `**Scope**: ${exactSkill.scope}`,
          "",
          "---",
          "",
          exactSkill.definition.template.trim(),
          "",
        ].join("\n");
      }

      const list = formatCommandList(all);
      return `Command or skill "/${args.command}" not found.\n\n${list}`;
    },
  });
}

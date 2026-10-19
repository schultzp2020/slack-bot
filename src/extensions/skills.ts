// Agent Skills support (agentskills.io spec, as Pi implements it): SKILL.md
// directories are discovered in ./.agents/skills and ~/.agents/skills, advertised to
// the model by name + description in the system prompt, and loaded in full
// only when the task calls for it. Skill scripts run with the bash tool; the
// skill tool reads SKILL.md and supporting files. No extra deps.
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

/** Parse the subset of frontmatter we route on: single-line name and description. */
export function parseFrontmatter(text: string, dir: string): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (kv !== null) {
      fields.set(kv[1], kv[2]);
    }
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) {
    return undefined;
  }
  return { name, description, dir };
}

/** Discover SKILL.md dirs under root, recursively; first discovery of a name wins, as in Pi. */
export function scanSkills(root: string, out: Map<string, Skill>): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // missing dir is fine
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const dir = join(root, entry.name);
    let text: string;
    try {
      text = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      scanSkills(dir, out); // no SKILL.md here; discover recursively, as Pi does
      continue;
    }
    const skill = parseFrontmatter(text, dir);
    if (skill !== undefined) {
      out.set(skill.name, skill);
    }
  }
}

export function loadSkills(): Skill[] {
  const byName = new Map<string, Skill>();
  scanSkills(".agents/skills", byName); // project skills, Pi-compatible location
  scanSkills(join(homedir(), ".agents", "skills"), byName); // user skills, Pi-compatible
  return [...byName.values()];
}

const skills = loadSkills();
const byName = new Map(skills.map((skill) => [skill.name, skill]));

const skillTool = defineTool({
  name: "skill",
  description:
    "Load an agent skill's instructions. With only `name`, returns its SKILL.md. " +
    "With `path` (relative, inside the skill's directory), returns that supporting file.",
  parameters: Type.Object({
    name: Type.String(),
    path: Type.Optional(Type.String()),
  }),
  execute: async (args) => {
    const skill = byName.get(args.name);
    if (skill === undefined) {
      return {
        isError: true,
        output: [
          {
            type: "text",
            text: `unknown skill: ${args.name}. Available: ${skills.map((s) => s.name).join(", ")}`,
          },
        ],
      };
    }
    // Supporting files are readable only inside the skill's own directory.
    let file = join(skill.dir, "SKILL.md");
    if (args.path !== undefined) {
      const resolved = join(skill.dir, args.path);
      if (!resolved.startsWith(skill.dir)) {
        return {
          isError: true,
          output: [{ type: "text", text: `path escapes the skill directory: ${args.path}` }],
        };
      }
      file = resolved;
    }
    try {
      return { output: [{ type: "text", text: await readFile(file, "utf8") }] };
    } catch {
      return {
        isError: true,
        output: [{ type: "text", text: `cannot read: ${args.path ?? "SKILL.md"}` }],
      };
    }
  },
});

const tools: ToolRegistration[] = [skillTool];

const extension: Extension = defineExtension({
  name: "skills",
  tools,
  sections: [
    section("skills", () =>
      skills.length === 0
        ? undefined
        : `Agent skills available — load one with the skill tool before doing work it covers; run its bundled scripts with the bash tool:\n${skills
            .map((skill: Skill) => `- ${skill.name}: ${skill.description}`)
            .join("\n")}`,
    ),
  ],
});

export default extension;

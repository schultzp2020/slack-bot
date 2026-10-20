// Agent Skills support (agentskills.io spec, as Pi implements it): SKILL.md
// directories are discovered in ./.agents/skills and ~/.agents/skills, advertised to
// the model by name + description in the system prompt, and loaded in full
// only when the task calls for it. Skill scripts run with the bash tool; the
// skill tool reads SKILL.md and supporting files. No extra deps.
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SKILLS_ALWAYS_LOAD, SKILLS_ROOTS } from "../config.ts";
import { Type } from "@earendil-works/pi-ai";
import { parse } from "yaml";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { offlineFloors } from "./warden.ts";

// The warden's offline opinion: the skill tool only reads files inside a
// skill's own directory, so it vouches read-only and never needs approval.
offlineFloors.push((tool: string, _args: JsonObject) => {
  void _args;
  return tool === "skill" ? false : undefined;
});

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

/** Parse the frontmatter we route on (name, description) with a real YAML
 * parser — skill frontmatter is YAML by spec, including `|` block-scalar
 * descriptions. Malformed frontmatter means the skill is skipped. */
export function parseFrontmatter(text: string, dir: string): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return undefined;
  }
  let fields: unknown;
  try {
    fields = parse(match[1]);
  } catch {
    return undefined;
  }
  if (typeof fields !== "object" || fields === null) {
    return undefined;
  }
  const { name, description } = fields as { name?: unknown; description?: unknown };
  if (typeof name !== "string" || name === "") {
    return undefined;
  }
  if (typeof description !== "string") {
    return undefined;
  }
  const folded = description.replaceAll(/\s+/gu, " ").trim(); // block scalars fold to one line
  if (folded === "") {
    return undefined;
  }
  return { name, description: folded, dir };
}

/**
 * Discover SKILL.md dirs under root, recursively. The first discovery of a
 * name wins (earlier roots and shallower entries shadow later ones), as in Pi.
 */
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
    if (skill !== undefined && !out.has(skill.name)) {
      out.set(skill.name, skill); // first discovery wins; later duplicates shadow
    }
  }
}

export interface SkillsExtension {
  extension: Extension;
  tools: ToolRegistration[];
}

/**
 * Build the skills extension over the given scan roots (earlier roots win on
 * name collisions). Discovery, lookup, and file reads live inside; callers
 * learn nothing about the filesystem layout.
 */
export function createSkillsExtension(
  roots: readonly string[],
  alwaysLoad: readonly string[] = [],
): SkillsExtension {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    scanSkills(root, byName);
  }
  const skills = [...byName.values()];

  // Preloaded skills: their SKILL.md body renders into the system prompt, so
  // the model always knows their patterns without a skill-tool round-trip.
  const preloaded: { name: string; body: string }[] = [];
  for (const name of alwaysLoad) {
    const skill = byName.get(name);
    if (skill === undefined) {
      continue; // not discovered under the configured roots
    }
    try {
      const text = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
      // Strip the frontmatter; the body is the instruction content.
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
      if (body !== "") {
        preloaded.push({ name, body });
      }
    } catch {
      // unreadable skill file: nothing to preload
    }
  }
  const preloadNames = new Set(preloaded.map((p) => p.name));

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

  const extension = defineExtension({
    name: "skills",
    tools: [skillTool],
    sections: [
      section("skills", () =>
        skills.length === 0
          ? undefined
          : `Agent skills available — load one with the skill tool before doing work it covers; run its bundled scripts with the bash tool:\n${skills
              .filter((skill: Skill) => !preloadNames.has(skill.name))
              .map((skill: Skill) => `- ${skill.name}: ${skill.description}`)
              .join("\n")}`,
      ),
      // Preloaded skills render after the advertisement, one section each,
      // so their instructions are always in context.
      ...preloaded.map((p) =>
        section(
          `skill-${p.name}`,
          () => `Skill ${p.name} (already loaded — do not load it again):\n\n${p.body}`,
        ),
      ),
    ],
  });

  return { extension, tools: [skillTool] };
}

// The installed extension over the configured scan roots (earlier roots win
// on name collisions). Defaults: project skills first (Pi-compatible
// location), then user skills.
const installed = createSkillsExtension(
  SKILLS_ROOTS.map((root) => (root.startsWith("~") ? join(homedir(), root.slice(1)) : root)),
  SKILLS_ALWAYS_LOAD,
);

export default installed.extension;

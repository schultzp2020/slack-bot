// Agent Skills support (agentskills.io spec, as Pi implements it): SKILL.md
// directories are discovered in ./.agents/skills and ~/.agents/skills, advertised to
// the model by name + description in the system prompt, and loaded in full
// only when the task calls for it. Scripts bundled with a skill run through
// run_script: scoped to the skill's directory, no shell, interpreter by
// extension. Progressive disclosure, no extra deps.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { offlineFloors } from "./warden.ts";
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

/** Script execution cap; a stuck script must not pin the conversation. */
const SCRIPT_TIMEOUT_MS = 120_000;

/** Run one script with its interpreter, capturing output; kills it after the timeout. */
function runScriptProcess(
  interpreter: string,
  script: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(interpreter, [script, ...args], { cwd });
    let output = "";
    proc.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(`timed out after ${SCRIPT_TIMEOUT_MS}ms:\n${output}`);
    }, SCRIPT_TIMEOUT_MS);
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve(`${interpreter} failed to start: ${error.message}`);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : `exit ${code}:\n${output}`);
    });
  });
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

// Scoped script runner: executes only files inside a skill's directory,
// interpreter by extension, argv passed directly (no shell). The scripts are
// reviewed code from the skills repos; this keeps the model off arbitrary commands.
const runScriptTool = defineTool({
  name: "run_script",
  description:
    "Run a script bundled with a skill. `skill` and `path` locate it (path relative to the " +
    "skill directory); `args` are passed to the script verbatim. Interpreters: .py, .js/.mjs, .sh.",
  parameters: Type.Object({
    skill: Type.String(),
    path: Type.String(),
    args: Type.Optional(Type.Array(Type.String())),
  }),
  execute: async (args) => {
    const skill = byName.get(args.skill);
    if (skill === undefined) {
      return { isError: true, output: [{ type: "text", text: `unknown skill: ${args.skill}` }] };
    }
    const script = join(skill.dir, args.path);
    if (!script.startsWith(skill.dir)) {
      return {
        isError: true,
        output: [{ type: "text", text: `path escapes the skill directory: ${args.path}` }],
      };
    }
    const interpreter = script.endsWith(".py")
      ? (process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"))
      : script.endsWith(".js") || script.endsWith(".mjs")
        ? process.execPath
        : script.endsWith(".sh")
          ? "bash"
          : undefined;
    if (interpreter === undefined) {
      return {
        isError: true,
        output: [{ type: "text", text: `unsupported script type: ${args.path}` }],
      };
    }
    const result = await runScriptProcess(interpreter, script, args.args ?? [], skill.dir);
    return { output: [{ type: "text", text: result.slice(0, 30_000) }] };
  },
});

const tools: ToolRegistration[] = [skillTool, runScriptTool];

const extension: Extension = defineExtension({
  name: "skills",
  tools,
  sections: [
    section("skills", () =>
      skills.length === 0
        ? undefined
        : `Agent skills available — load one with the skill tool before doing work it covers; run its bundled scripts with run_script:\n${skills
            .map((skill: Skill) => `- ${skill.name}: ${skill.description}`)
            .join("\n")}`,
    ),
  ],
});

export default extension;

// run_script floor: write-named scripts hold when the classifier is unreachable.
offlineFloors.push((tool: string, args) => {
  if (tool !== "run_script") {
    return undefined;
  }
  const path = typeof args.path === "string" ? args.path.toLowerCase() : "";
  return /(create|update|link|bump|trigger|sync|delete|close)/.test(path) ? true : undefined;
});

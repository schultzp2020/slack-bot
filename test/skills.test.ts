// Skills interface tests: discovery, duplicate precedence, and file reads,
// through the extension's own seam (createSkillsExtension over temp roots and
// its registered tool), not the parser/scanner internals.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillsExtension, parseFrontmatter } from "../src/extensions/skills.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function skillRoot(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(root);
  for (const [name, body] of Object.entries(entries)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), body);
  }
  return root;
}

// Minimal stand-in for the tool execution api/context the skill tool ignores.
const noApi = {} as never;
const noContext = {} as never;

/** The result's text blocks joined, for substring assertions. */
function textOf(result: { output?: unknown[] }): string {
  return (result.output ?? [])
    .map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
    .join("\n");
}

function skillTool(roots: readonly string[]) {
  const { tools } = createSkillsExtension(roots);
  const [tool] = tools;
  return tool;
}

describe("skills extension", () => {
  it("discovers skills and reads SKILL.md and supporting files through the tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    dirs.push(root);
    mkdirSync(join(root, "alpha"));
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: does a thing\n---\ninstructions",
    );
    writeFileSync(join(root, "alpha", "helper.py"), "print('hi')");
    const tool = skillTool([root]);
    const doc = await tool.execute({ name: "alpha" }, noApi, noContext);
    expect(doc.isError).toBeFalsy();
    expect(textOf(doc)).toContain("instructions");
    const helper = await tool.execute({ name: "alpha", path: "helper.py" }, noApi, noContext);
    expect(textOf(helper)).toContain("print");
  });

  it("first discovery of a name wins, across roots and within a root", async () => {
    const first = skillRoot({
      dup: "---\nname: dup\ndescription: from first root\n---\nfirst",
      nested: "---\nname: nested\ndescription: outer\n---\n",
    });
    // A same-named skill nested inside another skill dir, scanned after "dup"
    // alphabetically? "nested" scans after "dup" either way; add an inner dup.
    mkdirSync(join(first, "nested", "inner"));
    writeFileSync(
      join(first, "nested", "inner", "SKILL.md"),
      "---\nname: nested\ndescription: shadowed, must lose\n---\n",
    );
    const second = skillRoot({ dup: "---\nname: dup\ndescription: from second root\n---\nsecond" });
    const tool = skillTool([first, second]);
    const dup = await tool.execute({ name: "dup" }, noApi, noContext);
    expect(textOf(dup)).toContain("first");
    const nested = await tool.execute({ name: "nested" }, noApi, noContext);
    expect(textOf(nested)).toContain("outer");
  });

  it("parses block-scalar descriptions, as in real-world skills", () => {
    const skill = parseFrontmatter(
      "---\nname: humanizer\ndescription: |\n  Rewrite AI-sounding text so it reads like the writer.\n  Use when editing prose for AI tells.\nlicense: MIT\n---\nbody",
      "/x",
    );
    expect(skill).toMatchObject({
      name: "humanizer",
      description:
        "Rewrite AI-sounding text so it reads like the writer. Use when editing prose for AI tells.",
    });
  });

  it("rejects unknown names and paths escaping the skill directory", async () => {
    const root = skillRoot({ alpha: "---\nname: alpha\ndescription: d\n---\nbody" });
    const tool = skillTool([root]);
    const unknown = await tool.execute({ name: "nope" }, noApi, noContext);
    expect(unknown.isError).toBeTruthy();
    const escape = await tool.execute({ name: "alpha", path: "../other/secret" }, noApi, noContext);
    expect(escape.isError).toBeTruthy();
  });

  it("preloads named skills into the system prompt and drops them from the advertisement", () => {
    const root = skillRoot({ alpha: "---\nname: alpha\ndescription: d\n---\nALPHA INSTRUCTIONS" });
    const { extension } = createSkillsExtension([root], ["alpha"]);
    const sections = extension.sections ?? [];
    const preloaded = sections.find((s) => s.key === "skill-alpha");
    expect(preloaded?.render({} as never, noContext)).toContain("ALPHA INSTRUCTIONS");
    const advertised = sections.find((s) => s.key === "skills");
    expect(advertised?.render({} as never, noContext)).not.toContain("alpha:");
  });

  it("advertises discovered skills in its system-prompt section", () => {
    const root = skillRoot({ alpha: "---\nname: alpha\ndescription: does a thing\n---\n" });
    const { extension } = createSkillsExtension([root]);
    const skillsSection = extension.sections?.find((s) => s.key === "skills");
    const rendered = skillsSection?.render({} as never, noContext);
    expect(rendered).toContain("alpha: does a thing");
  });
});

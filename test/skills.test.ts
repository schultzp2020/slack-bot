import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Skill, parseFrontmatter, scanSkills } from "../src/extensions/skills.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function skillDir(name: string, frontmatter: string): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(root);
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`);
  return root;
}

describe("parseFrontmatter", () => {
  it("reads name and description", () => {
    const skill = parseFrontmatter("---\nname: a\ndescription: does a thing\n---\nbody", "/x");
    expect(skill).toMatchObject({ name: "a", description: "does a thing", dir: "/x" });
  });

  it("rejects missing fields or frontmatter", () => {
    expect(parseFrontmatter("---\nname: a\n---\n", "/x")).toBeUndefined();
    expect(parseFrontmatter("no frontmatter", "/x")).toBeUndefined();
  });
});

describe("scanSkills", () => {
  it("discovers nested skills, first name wins", () => {
    const root = skillDir("alpha", "name: alpha\ndescription: first");
    mkdirSync(join(root, "nested"));
    mkdirSync(join(root, "nested", "beta"));
    writeFileSync(
      join(root, "nested", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: nested\n---\n",
    );
    const out = new Map<string, Skill>();
    scanSkills(root, out);
    expect([...out.keys()]).toEqual(["alpha", "beta"]);
  });
});

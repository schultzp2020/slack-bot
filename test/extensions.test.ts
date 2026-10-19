import { describe, expect, it } from "vitest";
import { createRuntimeRegistry } from "../src/harness.ts";

describe("extension discovery", () => {
  it("installs every src/extensions module with a unique name", async () => {
    const registry = await createRuntimeRegistry();
    const installed = registry
      .snapshot()
      .installed()
      .map((extension) => extension.name);
    expect(installed).toContain("jira");
    expect(installed).toContain("skills");
    expect(installed).toContain("warden");
    expect(installed).toContain("codemode");
    expect(new Set(installed).size).toBe(installed.length);
  });
});

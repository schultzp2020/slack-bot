// Jira access for the model: shells out to the Atlassian CLI (acli).
import { spawn } from "node:child_process";
import type { JsonObject } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { commandPath } from "../util.ts";
import { offlineFloors } from "./warden.ts";

function runAcli(args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("acli", [...args], { shell: process.platform === "win32" });
    let output = "";
    proc.stdout.on("data", (chunk: string) => (output += chunk));
    proc.stderr.on("data", (chunk: string) => (output += chunk));
    proc.on("error", (error) => resolve(`acli failed to start: ${error.message}`));
    proc.on("close", (code) => resolve(code === 0 ? output : `exit ${code}:\n${output}`));
  });
}

export const jira = defineTool({
  name: "jira",
  description:
    "Run an Atlassian CLI (acli) command, e.g. ['jira', 'issue', 'view', 'PROJ-123'] or " +
    "['jira', 'work-item', 'list', '--jql', 'project = MYPROJECT']. Read-only use only.",
  parameters: Type.Object({ args: Type.Array(Type.String()) }),
  execute: async (args) => ({
    output: [{ type: "text", text: (await runAcli(args.args)).slice(0, 30_000) }],
  }),
});

// The warden's offline opinion for this tool. Only the command path counts:
// flag values (--fields comment, --jql "...linkedIssues(...)") are query
// parameters, not actions, so a write verb there must not read as a write.
// A path with no verb at all ("jira workitem", "jira workitem --help") only
// navigates or prints help — reading, not writing.
offlineFloors.push((tool: string, args: JsonObject) => {
  if (tool !== "jira") {
    return undefined;
  }
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  const path = commandPath(argv).join(" ");
  if (
    /\b(create|update|edit|delete|comment|transition|assign|link|move|close|reopen)\b/.test(path)
  ) {
    return true;
  }
  if (/\b(view|list|search|show|get|describe|fields|help)\b/.test(path)) {
    return false;
  }
  // No verb matched: bare navigation or help, which cannot change state.
  return false;
});

export default defineExtension({ name: "jira", tools: [jira] });

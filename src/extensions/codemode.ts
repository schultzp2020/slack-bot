// Code mode: the model writes JavaScript that runs in a QuickJS sandbox and
// calls our tools (jira, skill, run_script) in loops and branches — durably.
// A restart mid-script replays it from its journal instead of losing the work.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CODEMODE_MEMORY_LIMIT_BYTES } from "../config.ts";

const sandbox = new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES });

export default createCodemodeExtension({ sandbox });

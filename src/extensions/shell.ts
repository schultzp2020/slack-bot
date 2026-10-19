// pi-durable's coding tools (read/write/edit/bash) through the Node execution
// env: journaled output, crash-safe replay, progress streaming. The warden
// gates every call: bash/write/edit are always classified (no read-only
// shortcut) and hold when the classifier is down (fail closed); read is always
// classified too, and secret paths (.env, data/, .git) are hard-denied before
// classification — credentials never enter model context, even with approval.
import type { JsonObject } from "@earendil-works/pi-ai";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { offlineFloors } from "./warden.ts";

offlineFloors.push((_tool: string, _args: JsonObject) => {
  // No read-only vouchers here: read can walk the whole filesystem (only
  // secret paths are denied upstream), and bash/write/edit can change
  // anything. Always classified, fail closed when the classifier is down.
  void _tool;
  void _args;
  return undefined;
});

export { CodingTools as default };

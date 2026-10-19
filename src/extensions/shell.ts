// The durable coding tools (read, write, edit, bash) from pi-durable, running
// through the Node execution environment. Security is the warden's job: every
// bash/write/edit call is risk-scored and held above threshold until a human
// approves in-thread, and if the classifier is unreachable these tools hold
// (no floor vouches for them). `read` is vouched read-only and skips the
// classifier entirely.
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { JsonObject } from "@earendil-works/pi-ai";
import { offlineFloors } from "./warden.ts";

offlineFloors.push((tool: string, _args: JsonObject) => {
  // `read` only ever reads files: vouch read-only so it skips the classifier.
  if (tool === "read") {
    return false;
  }
  // bash/write/edit can change anything: no opinion, so they are always
  // classified and hold when the classifier is down (fail closed).
  return undefined;
});

export { CodingTools as default };

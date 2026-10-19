# How-to guides

Step-by-step recipes for common tasks. Each assumes the bot is set up (`docs/tutorial.md`).

## Add a tool

1. Create `src/extensions/<name>.ts` that default-exports a pi-durable `Extension` (copy `src/extensions/jira.ts` as a template).
2. In the same file, push an offline floor onto `offlineFloors` so the warden can judge your tool when the classifier is unreachable:

   ```ts
   import { offlineFloors } from "./warden.ts";

   offlineFloors.push((tool: string, args: JsonObject) => {
     if (tool !== "mytool") return undefined;
     return /write-verb-here/.test(JSON.stringify(args)) ? true : false;
   });
   ```

   `true` = write-shaped (holds on classifier outage), `false` = clearly read-only (also skips the classifier entirely), `undefined` = no opinion.

3. Run `pnpm check`. That's it — extensions are discovered from `src/extensions/` at startup and every registered tool is enabled automatically.

## Add a skill

1. Create `.agents/skills/<name>/SKILL.md` with frontmatter:

   ```markdown
   ---
   name: my-skill
   description: What it does and when to use it. Routing depends on this line.
   ---

   Instructions for the model...
   ```

2. Restart the bot. The skill is advertised in the system prompt by name and description; the model loads the full file with the `skill` tool when a task matches.

Skills bundled in `~/.agents/skills` are discovered too. Project skills shadow user skills with the same name. To run a skill's bundled scripts, the model uses `run_script` (interpreter by extension: `.py`, `.js`/`.mjs`, `.sh`).

## Approve a held action

When the warden holds a write (the reply says so and asks for approval):

1. Read the stated target, command, and failure mode in the thread.
2. Reply in the thread with a word like `approved`, `yes`, `do it`, `go ahead`, or `lgtm`.
3. The bot retries the held call; the approval opens a 10-minute window for that conversation.

## Restart the bot safely

```bash
# stop (graceful — clears the online presence and closes the harness)
# on Windows, find and stop the node process running src/index.ts, or Ctrl+C the console

pnpm dev
```

The PID lockfile (`data/bot.lock`) refuses a second instance while one is live, and takes over automatically from a dead one. Durable conversations resume where they left off, including runs interrupted mid-flight.

## Calibrate the warden

If read-only calls get held (false positives) or writes slip through (false negatives):

1. Check the held call's score in the block message (e.g. "scored it 0.80").
2. Tune `WARDEN_HOLD_SCORE` in `.env` — lower holds more, higher holds less. Default `0.75`.
3. For systematic false positives on your tool's read paths, fix its offline floor so those calls return `false` and skip the classifier entirely.

The classifier itself is your local llama.cpp server (`WARDEN_URL`, default `http://127.0.0.1:18080`). If it is down, the warden falls back to the offline floors and holds anything without a read-only opinion — fail closed.

## Run the checks

```bash
pnpm check   # lint (type-aware) + format + tests
```

Run this before every commit; CI runs the same thing.

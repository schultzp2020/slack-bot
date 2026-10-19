// Configuration loader: config.yaml holds the settings, .env holds the
// secrets, and environment variables override both. This module keeps the
// typed surface the rest of the code imports.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface ConfigFile {
  model: {
    base_url: string;
    id: string;
    name: string;
    context_window: number;
    max_tokens: number;
    reasoning: boolean;
  };
  warden: {
    url: string;
    model: string;
    hold_score: number;
    injection_score: number;
    approval_window_ms: number;
  };
  codemode: { memory_mb: number };
  system_prompt: string;
}

const file = parse(readFileSync("config.yaml", "utf8")) as ConfigFile;

// --- Model ----------------------------------------------------------------

export const MODEL_BASE_URL = process.env.MODEL_BASE_URL ?? file.model.base_url;
export const MODEL_NAME = file.model.name;
export const MODEL_ID = process.env.MODEL_ID ?? file.model.id;
export const MODEL_CONTEXT_WINDOW = file.model.context_window;
export const MODEL_MAX_TOKENS = file.model.max_tokens;
export const MODEL_REASONING = file.model.reasoning;

// --- Warden (local-classifier approval gate) -------------------------------

/** Local llama.cpp System One classifier server. */
export const WARDEN_URL = process.env.WARDEN_URL ?? file.warden.url;
/** Served classifier model id. */
export const WARDEN_MODEL = process.env.WARDEN_MODEL ?? file.warden.model;
/** Risk score at or above which a tool call is held for in-thread approval. */
export const WARDEN_HOLD_SCORE = Number(process.env.WARDEN_HOLD_SCORE ?? file.warden.hold_score);
/** Injection score at or above which tool output is wrapped as untrusted. */
export const WARDEN_INJECTION_SCORE = Number(
  process.env.WARDEN_INJECTION_SCORE ?? file.warden.injection_score,
);
/** How long an in-thread approval opens the gate, in milliseconds. */
export const WARDEN_APPROVAL_WINDOW_MS = file.warden.approval_window_ms;

// --- Codemode ----------------------------------------------------------------

/** QuickJS sandbox memory limit for the codemode tool. */
export const CODEMODE_MEMORY_LIMIT_BYTES =
  Number(process.env.CODEMODE_MEMORY_MB ?? file.codemode.memory_mb) * 1024 * 1024;

// --- Prompt ----------------------------------------------------------------

export const SYSTEM_PROMPT = file.system_prompt;

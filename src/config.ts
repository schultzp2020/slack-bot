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
    classifier: {
      backend: "llama-cpp" | "openai" | "jev";
      url: string;
      model: string;
      api_key_env?: string;
    };
    hold_score: number;
    injection_score: number;
    approval_window_ms: number;
  };
  codemode: { memory_mb: number };
  threads: { ttl_days: number };
  commands?: CommandConfig[];
  schedules?: ScheduleConfig[];
  system_prompt: string;
}

export interface CommandConfig {
  name: string;
  description: string;
  prompt?: string;
}

export interface ScheduleConfig {
  name: string;
  daily_at: string;
  channel: string;
  prompt: string;
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

/** Which classifier backend judges tool calls: a local llama-server, an OpenAI-compatible endpoint, or Typesafe Jev. */
export type WardenBackend = "llama-cpp" | "openai" | "jev";

/** The configured classifier backend. */
export const WARDEN_BACKEND = (process.env.WARDEN_BACKEND ??
  file.warden.classifier.backend) as WardenBackend;

/** Classifier server root: a llama-server root for llama-cpp, the API base (including /v1) for openai/jev. */
export const WARDEN_URL = process.env.WARDEN_URL ?? file.warden.classifier.url;

/** Served classifier model id. */
export const WARDEN_MODEL = process.env.WARDEN_MODEL ?? file.warden.classifier.model;

/** API key for remote backends (openai, jev); undefined for local llama-cpp. */
export const WARDEN_API_KEY: string | undefined =
  WARDEN_BACKEND === "llama-cpp"
    ? undefined
    : process.env[file.warden.classifier.api_key_env ?? "WARDEN_API_KEY"];
/** Risk score at or above which a tool call is held for in-thread approval. */
export const WARDEN_HOLD_SCORE = Number(process.env.WARDEN_HOLD_SCORE ?? file.warden.hold_score);
/** Injection score at or above which tool output is wrapped as untrusted. */
export const WARDEN_INJECTION_SCORE = Number(
  process.env.WARDEN_INJECTION_SCORE ?? file.warden.injection_score,
);
/** How long a held call's approval code is valid, in milliseconds. */
export const WARDEN_APPROVAL_WINDOW_MS = file.warden.approval_window_ms;

// --- Codemode ----------------------------------------------------------------

/** How long a thread's conversation stays alive without use before retirement. */
export const THREAD_TTL_MS = file.threads.ttl_days * 24 * 60 * 60_000;

/** QuickJS sandbox memory limit for the codemode tool. */
export const CODEMODE_MEMORY_LIMIT_BYTES =
  Number(process.env.CODEMODE_MEMORY_MB ?? file.codemode.memory_mb) * 1024 * 1024;

// --- Commands and schedules ----------------------------------------------------

/** Slash commands: /name [text] runs the preset prompt. Also declare each in manifest.yml. */
export const COMMANDS: CommandConfig[] = file.commands ?? [];

/** Scheduled turns; a run missed while the bot was down is caught up on startup. */
export const SCHEDULES: ScheduleConfig[] = file.schedules ?? [];

// --- Prompt ----------------------------------------------------------------

export const SYSTEM_PROMPT = file.system_prompt;

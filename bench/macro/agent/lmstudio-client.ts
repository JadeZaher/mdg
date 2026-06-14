/**
 * OpenAI-format client pointed at a local LM Studio server.
 *
 * LM Studio exposes an OpenAI-compatible /v1 surface at
 * http://localhost:1234/v1 by default. Any model loaded in LM Studio
 * with tool-calling enabled can be used as a bench agent — useful for
 * iterating on bench harness changes without paying per call, and for
 * comparing small local models against frontier providers.
 *
 * Env overrides:
 *   MPG_BENCH_LMSTUDIO_BASE_URL — default "http://localhost:1234/v1"
 *   MPG_BENCH_LMSTUDIO_API_KEY  — default "lm-studio" (LM Studio accepts any non-empty string)
 *   MPG_BENCH_LMSTUDIO_TIMEOUT_MS — default 600000 (10 min; local models can be slow)
 */

export type OpenAIClient = import("openai").default;

let _client: OpenAIClient | null = null;

export async function getLMStudioClient(): Promise<OpenAIClient> {
  if (_client) return _client;
  let OpenAI: typeof import("openai").default;
  try {
    OpenAI = ((await import("openai")) as { default: typeof import("openai").default }).default;
  } catch {
    throw new Error("Could not load openai — run: npm install --save-dev openai");
  }
  const baseURL = process.env.MPG_BENCH_LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
  const apiKey = process.env.MPG_BENCH_LMSTUDIO_API_KEY ?? "lm-studio";
  const timeout = Number(process.env.MPG_BENCH_LMSTUDIO_TIMEOUT_MS ?? 600_000);
  _client = new OpenAI({
    apiKey,
    baseURL,
    timeout,
    maxRetries: 0,
  });
  return _client;
}

/** Default model when using LM Studio. Override with MPG_BENCH_MODEL. */
export const DEFAULT_LMSTUDIO_MODEL = "ibm/granite-4-h-tiny";

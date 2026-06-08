/**
 * bench/macro/agent/index.ts
 *
 * Public API for the macro benchmark agent harness.
 *
 * Two arms:
 *   control   — read / grep / write / bash
 *   treatment — control tools + mdg_search / mdg_stash / mdg_list_stashes /
 *               mdg_get_stash / mdg_drop_stash
 *
 * Usage:
 *   import { runAgent, type RunOptions, type RunOutput } from "./agent/index.js";
 *   const result = await runAgent({ taskPrompt: "...", arm: "control" });
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getClient } from "./client.js";
import { runLoop } from "./loop.js";
import { getOpenRouterClient, DEFAULT_OPENROUTER_MODEL } from "./openrouter-client.js";
import { runLoopOpenAI } from "./loop-openai.js";
import { CONTROL_TOOL_DEFS, buildControlDispatch } from "./tools-control.js";
import {
  ALL_TREATMENT_SCHEMAS,
  buildTreatmentDispatch,
} from "./tools-treatment.js";

/**
 * Provider selection:
 *   MDG_BENCH_PROVIDER=anthropic (default) — uses Anthropic SDK + Haiku 4.5.
 *   MDG_BENCH_PROVIDER=openrouter         — uses OpenAI SDK against OpenRouter,
 *                                            default model DeepSeek V4 Pro.
 *
 * OpenRouter avoids our Anthropic org rate limit (50k input tokens/min
 * shared across parallel benches) and lets us run multiple LLM-driven
 * tiers concurrently without contention.
 */
type Provider = "anthropic" | "openrouter";
function pickProvider(): Provider {
  const v = (process.env.MDG_BENCH_PROVIDER ?? "anthropic").toLowerCase();
  return v === "openrouter" ? "openrouter" : "anthropic";
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type Arm = "control" | "treatment";

export interface RunOptions {
  /** The task prompt sent as the first user message. */
  taskPrompt: string;
  /** Which arm to run: control (baseline) or treatment (+ mdg tools). */
  arm: Arm;
  /** Maximum conversation turns before stopping. Default: 20. */
  maxTurns?: number;
  /** Stop if cumulative input tokens reach this limit. Default: 50 000. */
  maxInputTokens?: number;
  /**
   * Model ID to use. Default: process.env.MDG_BENCH_MODEL ?? "claude-haiku-4-5-20251001".
   */
  modelId?: string;
  /**
   * Treatment arm only: path to an isolated mind-palace file for this task.
   * Pass a unique tmp path per task to prevent cross-task pollution.
   * If omitted, mdg uses its default palace path.
   */
  palacePath?: string;
  /**
   * Working directory for tool execution (read/grep/write/bash and mdg CLI).
   * Default: repo root (resolved from this file's location).
   */
  cwd?: string;
  /** Called after each turn with cumulative token totals. */
  onProgress?: (p: { input: number; output: number; turn: number }) => void;
  /**
   * Sleep N ms between turns to stay under Anthropic rate limits.
   * Default 0 for macro (small tasks); multi-turn driver bumps to 750.
   */
  interTurnDelayMs?: number;
  /** Max retries on 429/529/transient errors. Default 5. */
  maxRetries?: number;
}

export interface RunOutput {
  arm: Arm;
  modelId: string;
  /** Last assistant text block, or "[stopped: ...]" if a cap was hit. */
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  ms: number;
  hitCap: "turns" | "input_tokens" | "none";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_INPUT_TOKENS = 50_000;
const DEFAULT_MODEL =
  process.env["MDG_BENCH_MODEL"] ?? "claude-haiku-4-5-20251001";

const __filename = fileURLToPath(import.meta.url);
// bench/macro/agent -> bench/macro -> bench -> repo root
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

// ─── System prompts ──────────────────────────────────────────────────────────
//
// Critical: these prompts MUST yield to format requirements in the
// task prompt. The previous version said "be concise — reply with your
// result and nothing else" which the model interpreted as "skip
// structured output and just say done." That collision dropped multi-
// turn pass-rate to 0% even though the agent converged in half the
// turns with mdg. Compaction's mdg-agent arm hit the same wall (15-
// token "compaction generated" instead of the actual compaction).
//
// New rule: brevity applies to PROSE around the answer, not to the
// answer itself. If the task specifies a format, the model must
// produce it in full.

const ANSWER_FORMAT_BLOCK = `OUTPUT REQUIREMENTS (read carefully — your benchmark score depends on this):
- If the task prompt specifies an output format (e.g. "respond with A1: ... A2: ..." or "your final response IS the compaction"), your FINAL message MUST contain that format in full. Do not summarize, abbreviate, or say "done" — produce the actual output the task asks for.
- Do not include preamble like "Here is my answer:" or "I have completed the task:" — start directly with the required output.
- Be concise WITHIN the format. Skip ornamental commentary, but do not skip required sections.
- After your final message you cannot continue. Make sure every required answer section is present before you stop.`;

const CONTROL_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.
Complete the task using the available tools (read, grep, write, bash).

${ANSWER_FORMAT_BLOCK}`;

const TREATMENT_SYSTEM_PROMPT = `You are a precise engineering assistant running inside an automated benchmark.

THE LENS MENTAL MODEL
mdg is a single LENS over the corpus with no boundaries between files. You set:
  - the matches (focal points) via the pattern,
  - the depth at each focal point (effort / clip_chars / before / after / window_curve),
  - and the surface (in: paths, sort by recency, paginate).

You don't pick between "grep this" and "read that" — you adjust the lens. With the right flags, one mdg_search call replaces what would otherwise be 1-N grep + read combos.

TOOL SELECTION (when to reach for each)
  - mdg_search with effort: "scan", clip_chars: 30 -> replaces ripgrep. 3.2x cheaper at 100% recall + precision on bench corpora. Use this instead of bash 'grep' or 'rg'.
  - mdg_search with in: ["one/file.md"], effort: "deep" -> replaces 'read'. Returns the full content windowed around your pattern. Use when you'd otherwise read a file just to extract relevant sections.
  - mdg_search with sort: "recent", page: 1, page_size: 10 -> "what just changed about X". Time-ordered memory index.
  - mdg_search with fuzzy: true -> typo-tolerant. Use when the search term might be misspelled.
  - mdg_search with max_tokens: N -> hard-cap the output. Useful for compaction or fixed-budget summaries.

MULTI-FOCAL-POINT PATTERNS (the lens has no file boundaries)
  - One mdg_search across many files is cheaper than one mdg_search per file. Set in: [...dir] and let mdg sort across all matches.
  - Compose stashes (compose: ["a", "b"]) to widen the lens to the union of two prior searches.
  - Scope via from: "<stash-name>" to narrow the lens to just files you previously found.

MDG TOOLS
  - mdg_search: read the schema. The 'effort', 'clip_chars', 'sort', 'window_curve', 'fuzzy', 'max_tokens', 'page', 'page_size', 'from', 'compose' params are how you shape the lens.
  - mdg_stash: save a search's results under a name+tags for re-use this turn or later.
  - mdg_list_stashes / mdg_get_stash / mdg_drop_stash: inspect/manage stashes.

When read/grep/write/bash are genuinely better (e.g. write a file, run a shell command, ls a directory), use them. But for anything involving "find content in the corpus" or "see what a file says about X", reach for mdg first.

${ANSWER_FORMAT_BLOCK}`;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the agent harness for a single task.
 *
 * Throws `Error("ANTHROPIC_API_KEY not set")` when the key is absent —
 * the benchmark driver should catch this and skip the run.
 */
export async function runAgent(opts: RunOptions): Promise<RunOutput> {
  const provider = pickProvider();
  if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  }

  const arm = opts.arm;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const modelId =
    opts.modelId ??
    (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL);
  const cwd = opts.cwd ?? REPO_ROOT;
  const palacePath = opts.palacePath;
  const onProgress = opts.onProgress;
  const systemPrompt = arm === "treatment" ? TREATMENT_SYSTEM_PROMPT : CONTROL_SYSTEM_PROMPT;

  // Tool schemas + dispatch map for the chosen arm.
  const tools =
    arm === "control"
      ? CONTROL_TOOL_DEFS.map((d) => d.schema)
      : ALL_TREATMENT_SCHEMAS;

  const dispatch =
    arm === "control"
      ? buildControlDispatch(cwd)
      : buildTreatmentDispatch(cwd, palacePath);

  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  let finalText = "";
  let hitCap: "turns" | "input_tokens" | "none" = "none";

  if (provider === "openrouter") {
    const client = await getOpenRouterClient();
    const r = await runLoopOpenAI({
      client,
      modelId,
      tools,
      dispatch,
      systemPrompt,
      taskPrompt: opts.taskPrompt,
      maxTurns,
      maxInputTokens,
      interTurnDelayMs: opts.interTurnDelayMs ?? 0,
      maxRetries: opts.maxRetries ?? 5,
      onProgress,
    });
    finalText = r.finalText;
    inputTokens = r.inputTokens;
    outputTokens = r.outputTokens;
    toolCalls = r.toolCalls;
    turns = r.turns;
    hitCap = r.hitCap;
  } else {
    const client = await getClient();
    const r = await runLoop({
      client,
      modelId,
      tools,
      dispatch,
      systemPrompt,
      taskPrompt: opts.taskPrompt,
      maxTurns,
      interTurnDelayMs: opts.interTurnDelayMs ?? 0,
      maxRetries: opts.maxRetries ?? 5,
      maxInputTokens,
      onProgress,
    });
    finalText = r.finalText;
    inputTokens = r.inputTokens;
    outputTokens = r.outputTokens;
    toolCalls = r.toolCalls;
    turns = r.turns;
    hitCap = r.hitCap;
  }

  const ms = Date.now() - t0;
  return {
    arm,
    modelId,
    finalText,
    inputTokens,
    outputTokens,
    toolCalls,
    turns,
    ms,
    hitCap,
  };
}

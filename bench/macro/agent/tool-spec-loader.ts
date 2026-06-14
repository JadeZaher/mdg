/**
 * Tool-spec loader — pull mpg's canonical Anthropic-format tool descriptors
 * from the installed `mpg` CLI rather than hand-rolling them in this file.
 *
 * Opt-in via MPG_BENCH_USE_TOOL_SPEC=1. When unset, the bench keeps using the
 * hand-rolled schemas in tools-treatment.ts (existing baseline, stable
 * cross-run for reproducibility). When set, the bench replaces any tool whose
 * name appears in the spec with the spec version; tools NOT in the spec
 * (e.g. mpg_list_stashes / mpg_get_stash / mpg_drop_stash, which the current
 * spec doesn't yet enumerate) are kept from the hand-rolled set.
 *
 * The dispatch handlers in tools-treatment.ts are unaffected — they bind on
 * tool name. Only the schemas surfaced to the model change.
 *
 * Reasons to flip this on:
 *   - Validate that the published descriptors are accurate enough for agents
 *     to actually drive mpg correctly.
 *   - A/B the hand-tuned bench prompt vs the canonical published prompt.
 *   - Catch drift between docs and the CLI by failing fast in CI.
 */

import { spawnSync } from "node:child_process";

import type { Tool } from "./client.js";
export type { Tool };

/**
 * Returns true when the user has explicitly opted in.
 * Anything other than "1" / "true" / "yes" disables.
 */
export function isToolSpecEnabled(): boolean {
  const v = (process.env.MPG_BENCH_USE_TOOL_SPEC ?? "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

interface AnthropicToolDescriptor {
  name: string;
  description?: string;
  input_schema: unknown;
}

let _cached: Tool[] | null = null;
let _cachedError: string | null = null;

/**
 * Shell out to `mpg tool-spec --format anthropic` and parse the result.
 * Cached per-process; the descriptor doesn't change across calls within
 * a single bench run.
 *
 * Returns null on any failure (mpg missing, parse error, etc.) — the bench
 * falls back to hand-rolled schemas silently.
 */
export function loadMpgToolSpec(): Tool[] | null {
  if (_cached) return _cached;
  if (_cachedError) return null;
  try {
    const r = spawnSync("mpg", ["tool-spec", "--format", "anthropic"], {
      encoding: "utf8",
      timeout: 15_000,
      shell: process.platform === "win32",
    });
    if (r.status !== 0 || !r.stdout) {
      _cachedError = `mpg tool-spec exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`;
      return null;
    }
    const parsed = JSON.parse(r.stdout) as AnthropicToolDescriptor[];
    if (!Array.isArray(parsed)) {
      _cachedError = "mpg tool-spec did not return an array";
      return null;
    }
    _cached = parsed.map((d) => ({
      name: d.name,
      description: d.description ?? "",
      input_schema: d.input_schema as Tool["input_schema"],
    }));
    return _cached;
  } catch (err) {
    _cachedError = `mpg tool-spec spawn failed: ${(err as Error).message}`;
    return null;
  }
}

/**
 * Merge spec-sourced schemas into the existing hand-rolled set.
 * For any tool name present in BOTH the spec and the hand-rolled set,
 * the spec wins. Hand-rolled-only tools (list/get/drop stashes) survive.
 *
 * Returns the original list unchanged if the flag is off or the spec is
 * unavailable — so the caller doesn't need to guard.
 */
export function mergeToolSpec(handRolled: Tool[]): Tool[] {
  if (!isToolSpecEnabled()) return handRolled;
  const spec = loadMpgToolSpec();
  if (!spec) {
    process.stderr.write(
      `[tool-spec] MPG_BENCH_USE_TOOL_SPEC=1 but spec unavailable (${_cachedError ?? "unknown"}); falling back to hand-rolled schemas.\n`,
    );
    return handRolled;
  }
  const byName = new Map(spec.map((t) => [t.name, t]));
  const merged = handRolled.map((t) => byName.get(t.name) ?? t);
  // Surface what was actually swapped to stderr — useful for verifying the
  // bench saw the spec, especially on first-time runs.
  const swapped = handRolled
    .filter((t) => byName.has(t.name))
    .map((t) => t.name);
  if (swapped.length) {
    process.stderr.write(
      `[tool-spec] swapped ${swapped.length} schemas from mpg tool-spec: ${swapped.join(", ")}\n`,
    );
  }
  return merged;
}

/**
 * Tool-spec descriptors for the mpg tool surface.
 *
 * Returns JSON-serializable descriptor objects in OpenAI, Anthropic, or
 * Gemini function-calling shapes. No external deps.
 */

// ─── Shared JSON Schema fragments ────────────────────────────────────

const SEARCH_PROPERTIES = {
  pattern: {
    type: "string",
    description:
      "Regex pattern to search for (ripgrep syntax). Required.",
  },
  in: {
    type: "array",
    items: { type: "string" },
    description:
      "Paths to search: files, directories (recursive), globs, @file " +
      "indirection, @- for a newline-delimited file list on stdin.",
  },
  cmd: {
    type: "string",
    description: "Search the stdout of a shell command (captured inline).",
  },
  url: {
    type: "string",
    description: "Fetch and search a URL. Capped at 16 MB / 30 s.",
  },
  effort: {
    type: "string",
    enum: ["scan", "normal", "deep", "auto"],
    description:
      "Effort preset controlling per-node context windows and node cap. " +
      "scan=20t/100k-nodes (index pass), normal=500t/30n (default), " +
      "deep=2000t/100n (detailed drill). Override with max_tokens/max_nodes.",
  },
  max_tokens: {
    type: "number",
    description:
      "Total token budget across all returned nodes. Nodes are truncated " +
      "to fit. Combine with window_curve to shape the distribution.",
  },
  max_nodes: {
    type: "number",
    description: "Hard cap on number of nodes returned. Default varies by effort preset.",
  },
  clip_chars: {
    type: "number",
    description:
      "Sub-line clip mode: keep only N chars on each side of the matched " +
      "span within the match line. Drops line-level before/after context.",
  },
  sort: {
    type: "string",
    enum: ["relevance", "recent", "oldest"],
    description:
      "Node ordering. 'recent' = newest-edited files first (good with " +
      "window_curve:linear). 'oldest' = oldest first. Default: rg traversal order.",
  },
  window_curve: {
    type: "string",
    enum: ["flat", "linear", "log"],
    description:
      "Token-window decay across ranked nodes. flat=every node gets full " +
      "window. linear=decays to ~10% at last rank (~40% token savings). " +
      "log=gentler decay via full/log2(rank+2) (~53% savings). " +
      "Pair linear/log with sort:recent for budget-efficient scans.",
  },
  retriever: {
    type: "string",
    description:
      "Source retriever hint (reserved for future routing; currently ignored).",
  },
  mp_from: {
    type: "string",
    description:
      "Scope search to the file list from this named mind-palace stash. " +
      "~3× cheaper than re-searching the full tree.",
  },
  mp_stash: {
    type: "string",
    description:
      "After searching, save the result into a mind-palace stash with this name.",
  },
  mp_tag: {
    type: "string",
    description: "Tag(s) to apply when saving with mp_stash (comma-separated).",
  },
  mp_ttl: {
    type: "string",
    description:
      "Auto-expiry for the stash created by mp_stash. Examples: '4h', '1d', '7d'. " +
      "Pruned by palace.prune_expired.",
  },
  page: {
    type: "number",
    description: "1-indexed page number (enables pagination).",
  },
  page_size: {
    type: "number",
    description: "Nodes per page. Default 10.",
  },
};

const STASH_PROPERTIES = {
  name: {
    type: "string",
    description: "Mind-palace slot name (kebab-case recommended).",
  },
  note: {
    type: "string",
    description: "Free-form description of what this stash contains.",
  },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Tags for filtering and grouping stashes.",
  },
  replace: {
    type: "boolean",
    description:
      "If true, overwrite an existing stash with this name. Default: merge " +
      "(dedup by file:line).",
  },
  ttl: {
    type: "string",
    description: "Auto-expiry duration, e.g. '4h', '24h', '7d'.",
  },
  palace_path: {
    type: "string",
    description: "Override the palace file path.",
  },
};

// ─── Tool definitions ─────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "mpg_search",
    description:
      "Token-budgeted codebase search via ripgrep. Returns context nodes " +
      "with file:line attribution sized in tokens, not lines. Use effort " +
      "presets to control cost: scan for index passes, normal for targeted " +
      "queries, deep for detailed drill-downs. Scope repeat searches to " +
      "prior results with mp_from (3× cheaper than full re-scan). " +
      "Combine sort:recent + window_curve:linear for recency-weighted scans.",
    parameters: {
      type: "object",
      properties: SEARCH_PROPERTIES,
      required: ["pattern"],
    },
  },
  {
    name: "mpg_stash",
    description:
      "Save search results into a named mind-palace slot. Stashes survive " +
      "compaction and session boundaries. Recall with mpg_get_stash; use " +
      "as a search target via mpg_search(mp_from). Merges by default " +
      "(dedup by file:line); set replace:true to overwrite.",
    parameters: {
      type: "object",
      properties: STASH_PROPERTIES,
      required: ["name", "note"],
    },
  },
  {
    name: "mpg_list_stashes",
    description:
      "List all named mind-palace slots. Filter by tags. Use before " +
      "composing or re-searching to see what's already captured.",
    parameters: {
      type: "object",
      properties: {
        tag_filter: {
          type: "array",
          items: { type: "string" },
          description: "Only return stashes carrying all of these tags.",
        },
        palace_path: { type: "string", description: "Override palace file path." },
      },
      required: [],
    },
  },
  {
    name: "mpg_get_stash",
    description:
      "Retrieve a mind-palace slot. Returns card view by default (metadata, " +
      "tags, source paths, relations — no node bodies; much cheaper). " +
      "Pass with_nodes:true to include captured node text.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stash name." },
        with_nodes: {
          type: "boolean",
          description: "Include captured node bodies. Default false.",
        },
        palace_path: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "mpg_drop_stash",
    description:
      "Permanently remove a mind-palace slot. Use when a line of " +
      "investigation is complete to keep the palace below the 20-stash budget.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stash name to drop." },
        palace_path: { type: "string" },
      },
      required: ["name"],
    },
  },
];

// ─── Format adapters ──────────────────────────────────────────────────

/** OpenAI function-calling shape: array of { type, function: { name, description, parameters } }. */
function buildOpenAI(): object[] {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Anthropic tool-use shape: array of { name, description, input_schema }. */
function buildAnthropic(): object[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Gemini function-declaration shape: { functionDeclarations: [...] }. */
function buildGemini(): object {
  return {
    functionDeclarations: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}

// ─── Public export ────────────────────────────────────────────────────

/**
 * Build a JSON-serializable tool descriptor for the mpg surface.
 *
 * @param format "openai" | "anthropic" | "gemini"
 * @returns The format-specific descriptor object.
 */
export function buildToolSpec(format: "openai" | "anthropic" | "gemini"): object {
  switch (format) {
    case "openai":    return buildOpenAI();
    case "anthropic": return buildAnthropic();
    case "gemini":    return buildGemini();
    default:
      throw new Error(`Unknown tool-spec format: ${format as string}`);
  }
}

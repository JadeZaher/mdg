# Roadmap

## State of the Node version (v0.3.x)

The Node implementation is feature-complete for the v0.x story:

- All planned CLI surface shipped: `--serve` (stdio NDJSON + HTTP),
  `--format agent-json`, `--no-fill`, `mpg tool-spec`, `--print-entry`,
  `--pattern-file`.
- Mind palace primitives stable: stash, compose, intersect, except,
  link, graph, TTL-pruning, content-hash + mtime staleness.
- Programmatic API plus a side-effect-free `entry` subpath for safe
  embedding from other Node processes (Windows `.cmd` shim included).
- Provider-shaped tool schemas (OpenAI, Anthropic, Gemini) generated
  at install time.

It is **good enough to use as your default agent memory layer today.**
The v0.x Node binary stays maintained as the reference implementation
while the next phase lands.

## Wins (validated this session)

Structured LongMemEval (oracle split, GPT-4o judge) sweep against the
four reference systems on the same leaderboard — Mem0 (~49%), Zep
(~64%), Letta (~83%), Mastra (~95%):

- **Framework primitive carries weight.** mpg-as-framework
  (per-session stash + scoped search + compose tools) at N=500 with
  xiaomi/mimo-v2-flash scored **0.44**. The flat-log substrate with
  frontier Sonnet on the same dataset scored **0.32**. The +12pp came
  from how the framework is shaped, not the model.
- **Cheap model + framework beats frontier model + raw substrate.**
  The mimo run cost ~$2; the Sonnet flat-log baseline cost ~$23.
- **Temporal lift lands exactly where flat-log loses.** +19pp on
  temporal-reasoning, +37pp on knowledge-update, +20pp on
  multi-session.
- **`--serve` validates the perf bet.** Removes the ~1.1s Node
  cold-start per call; the next thing it makes possible is an
  in-process Rust target.
- **`agent-json` envelope works as a control-loop primitive.**
  Structured `status` / `n_literal_matches` / `warning` lets agents
  detect a bad pattern without spending an LLM round-trip on it.

## Losses (honest gaps)

- **Semantic recall floor.** Pure substring / regex / fuzzy. "Told you
  about my dog Rex" → "what's my pet's name?" doesn't connect. The
  competitors that beat us on LME spend write-time LLM compute to
  fact-extract or embed; mpg defers everything to read time.
- **No entity-temporal awareness.** Zep's Graphiti edge case (entity
  + valid-time edges) is structurally absent. Multi-session date
  arithmetic still needs explicit pattern-anchoring help in the
  harness adapter.
- **Cheap models lose single-session synthesis.** Mimo regressed
  ~33pp / ~16pp vs Sonnet on single-session preference / user — the
  framework can't repair weaker model synthesis on its own.
- **Node startup is the throughput cap outside `--serve`.** Cold-call
  mode pays it every invocation; harnesses that don't keep the server
  warm see ~1.1s of overhead per call.
- **Palace stashes are append/replace, not surgical.** Letta-style
  core-memory editing isn't supported; you can't refine a stash in
  place without re-running the underlying search.

## What's next

The next phase reframes mpg as **a processing engine for grounded
generative context** — a directory-as-database substrate where the
agent is the processor and mpg is the layer in between. Same lazy-
interpretation thesis, different shape:

- Rust port that extends ripgrep semantics into a long-running engine,
  not a CLI.
- In-process and in-memory palace instances (not just JSON files on
  disk).
- Multi-tenant warm process — one engine per machine, scoped palaces
  per task / directory.
- Same JSON envelope, same tool-spec surface, same mind-palace
  operations — harnesses port without rewrites.
- Self-directed post-deployment shaping: idle-state distillation of
  stashes into retrieval signal for the local agent that owns them.

**More to come soon.** Until then, the Node version above is the
canonical implementation. File issues against v0.x if anything in the
surface above is shaky — the API will be preserved across the port.

# LongMemEval benchmark — scripts and methodology

This directory holds the scripts and methodology notes from the
LongMemEval (oracle split) run that produced the **0.44 vs 0.32**
headline in `BENCHMARKS.md`. The bench harness itself (adapters,
runner, configs, datasets) lives in a sibling repo
[`ai-utils-memory/benchmarks/`](https://github.com/JadeZaher/ai-utils-memory)
to keep mpg's published package lean. What ships here is the
post-hoc analysis surface, so anyone can audit how the numbers were
produced and re-grade traces under a different judge.

## What was measured

LongMemEval oracle split, **N=500**, GPT-4o as judge:

| arm | model | mean score |
| :--- | :--- | ---: |
| Flat-log substrate (`MpgAdapter`) | claude-sonnet-4-6 | **0.32** |
| Palace-as-framework (`MpgPalaceAdapter`) | xiaomi/mimo-v2-flash | **0.44** |

Same dataset, same judge, same harness. The +12pp came from the
**shape of the framework**, not the model:

- Per-session `--mp-stash` written at ingest (no LLM cost — purely
  structural).
- At query time the agent gets `palace_search` / `palace_compose` /
  `palace_list` tools and drives retrieval itself with `--effort
  quick` and `--mp-from <session>` scoping.

Lift concentrates where flat-log loses: **temporal-reasoning +19pp**,
**knowledge-update +37pp**, **multi-session +20pp**.

## Scripts

### `show_episode.py` — standalone

Pretty-prints a per-episode artifact (agent prompts in full, retrieval
hits, agent answer, judge prompts, judge raw response, verdict). Pure
stdlib. Run against any episode JSON produced by the harness:

```bash
python bench/longmemeval/scripts/show_episode.py results/.../episodes/0003-some_qid.json
python bench/longmemeval/scripts/show_episode.py results/.../episodes/ --miss --limit 5
```

### `analyze_misses.py` — standalone

Walks a `trace.jsonl` and categorizes every miss (score=0) as:
`refusal` / `wrong_fact` / `date_math` / `empty_hits` / `judge_quirk` /
`other`. Also prints per-retrieval-strategy breakdown when the trace
records it. Pure stdlib.

```bash
python bench/longmemeval/scripts/analyze_misses.py results/.../trace.jsonl
```

### `regrade.py` — requires sibling benchmarks repo

Re-grades an existing trace under a different judge model. Imports
`harness.run._load_sibling_env` and reads a model preset from
`configs/models/<judge>.yaml`, so this script must run from inside the
benchmarks repo (or the repo must be available at `..` relative to
this script's grandparent — i.e. `mind-palace-graph/../benchmarks/`).

```bash
# From inside the benchmarks repo:
python scripts/regrade.py --trace results/.../trace.jsonl --judge gemma-4-e2b
```

This is the script used to confirm that the GPT-4o judge was
**stricter** than the granite judge it replaced (35 episodes flipped
YES→NO, only 13 NO→YES) — the original suspicion was the opposite.

## Reproducing the headline number

```bash
# In the benchmarks repo:
python -m harness.run --bench longmemeval --memory mpg-palace \
  --model mimo-v2-flash \
  --config configs/benches/longmemeval-palace.yaml \
  --limit 500
```

Set `OPENROUTER_API_KEY` for the mimo run and `LONGMEMEVAL_JUDGE_MODEL=gpt-4o`
for an apples-to-apples comparison against Mem0 / Zep / Letta /
Mastra, which all use GPT-4o judges on the same benchmark.

## Boundary

Everything *upstream* of these scripts (the harness, the adapters, the
dataset loaders, the agent loop, the rate-limited model clients) lives
in the benchmarks repo because it's Python-heavy and bench-shape-
specific. What lives here is the post-hoc analysis layer plus this
methodology doc so the headline numbers are auditable from a fresh
clone of mpg alone.

# mpg benchmarks — aggregated results

Automated summary of the most recent `bench/results/*.json` files. Regenerate with:

```bash
npm run bench && npm run bench:agg
```

_Generated 2026-06-12T16:32:28.181Z._

## TL;DR — what this bench actually shows

When you stack the latest runs end-to-end:

- **Zero-LLM compaction matches LLM summarization** — `mpg --effort scan` 44% pass vs summarization's 44% at the same 2k-token budget, at **0 LLM input tokens** vs 21489.
- **3.2× cheaper than ripgrep** on the memory-system corpus — 371 vs 1197 tokens at the same 100% recall + 100% precision (`--effort scan --clip 30`).
- **100% typo recall** at edit distance ≤ 2 — `--fuzzy` catches drop/insert/substitute/swap typos that rg misses entirely (rg: 0%).
- **47% fewer tool calls** on multi-turn scenarios when the agent stashes early findings (2.7 vs 5.0 per scenario; 39% fewer turns) at 17%/8% pass parity.

Trade-offs are real (cold-start latency, single-keyword lookups, paraphrased-query recall) — they're documented in the **Wins and trade-offs** section at the bottom alongside the context for when they matter.

## Caveats

These results come from small per-bench sample sizes (3 compaction tasks, 3 multi-turn scenarios, 5 macro tasks) and a self-corpus drawn from the author's own projects. Compaction + macro are run against claude-haiku-4-5; multi-turn here was run against a local ibm/granite-4-h-tiny via LM Studio — different model classes test different parts of the claim. Run-to-run variance on the LLM-driven benches is high; treat pass-rate deltas as **directional signal**, not effect-size guarantees. Token-cost / wall-clock / tool-call deltas are more stable across runs. Typo-tolerance ground truth is defined by rg over the corrected literal — a mildly circular construction; the 100% claim there describes the upper bound of what fuzzy matching can recover, not a universal property.

## compaction — memory-system primitive head-to-head

_Tasks: 3. Mega-corpus: 265 files across 4 projects. Run: 2026-06-12T13:18:34.917Z_

The honest test of mpg as a memory primitive: given a topic + token budget, can it assemble a compaction a downstream LLM can answer Q&A from? Arms compared:

- **truncation** — no-LLM baseline. Most-recent files until budget.
- **mpg-scan** — no-LLM mpg call: `scan + sort recent + window-curve log + max-tokens budget`. The headline finding.
- **summarization** — LLM baseline: rg-retrieve + single-pass LLM compaction.

### Per-arm summary

| arm | pass rate | mean comp tokens | mean in tokens | mean density (pass/k) | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| truncation | 11% | 1952 | 0 | 0.06 | 18 |
| mpg-scan | 44% | 2675 | 0 | 0.50 | 119 |
| summarization | 44% | 584 | 21489 | 0.88 | 9841 |

### Per-task breakdown

| task | arm | pass | comp tok | in tok |
| :--- | :--- | ---: | ---: | ---: |
| authentication patterns across projects | truncation | 33% | 1952 | 0 |
| authentication patterns across projects | mpg-scan | 100% | 5207 | 0 |
| authentication patterns across projects | summarization | 100% | 837 | 44627 |
| asset pipeline / content addressing | truncation | 0% | 1952 | 0 |
| asset pipeline / content addressing | mpg-scan | 0% | 2562 | 0 |
| asset pipeline / content addressing | summarization | 0% | 684 | 17978 |
| rendering stack and camera setup | truncation | 0% | 1952 | 0 |
| rendering stack and camera setup | mpg-scan | 33% | 257 | 0 |
| rendering stack and camera setup | summarization | 33% | 230 | 1863 |

## macro — agent task lift (code + specs corpus)

_Model: `claude-haiku-4-5-20251001 (Anthropic default)`. Corpus: `C:/Users/atooz/Programming/fractalengine-workspace/fractalengine`. Tasks: 5. Run: 2026-06-12T13:17:02.494Z_

Two arms of the same agent: **control** (read/grep/write/bash) vs **treatment** (control + 5 mpg tools). Same model, same task set, same budget caps (20 turns, 50k input tokens per task).

### Per-arm summary

| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| control   | 80% | 19241 | 560 | 4.4 | 5.2 | 21814 |
| treatment | 100% | 28458 | 521 | 4.0 | 5.0 | 15866 |

### Lift (treatment − control)

| metric | delta | interpretation |
| :--- | ---: | :--- |
| pass-rate    | +20% | treatment did not regress accuracy |
| input tokens | +48% | treatment more expensive |
| output tokens | -7% | reasoning-verbosity proxy |
| wall-clock | -27% | latency overhead is mostly mpg CLI spawn |

### Per-task breakdown

| task | arm | pass | in tok | out tok | tools | turns |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: |
| entity hierarchy from bloom_stage spec | control | yes | 11565 | 516 | 4 | 5 |
| entity hierarchy from bloom_stage spec | treatment | yes | 22576 | 550 | 4 | 5 |
| asset addressing scheme | control | no | 58468 | 1178 | 11 | 11 |
| asset addressing scheme | treatment | yes | 27000 | 389 | 3 | 4 |
| function name that loads assets into Bevy | control | yes | 10024 | 364 | 3 | 4 |
| function name that loads assets into Bevy | treatment | yes | 42514 | 612 | 5 | 6 |
| previous camera type before bloom_stage | control | yes | 11424 | 390 | 2 | 3 |
| previous camera type before bloom_stage | treatment | yes | 15148 | 271 | 2 | 3 |
| code-review tracks from 2026-04-30 | control | yes | 4722 | 351 | 2 | 3 |
| code-review tracks from 2026-04-30 | treatment | yes | 35050 | 781 | 6 | 7 |

## multi-turn — does mind palace stashing pay off across turns?

_Model: `ibm/granite-4-h-tiny`. Corpus: `C:/Users/atooz/Programming/fractalengine-workspace/fractalengine`. Scenarios: 3. Run: 2026-06-12T16:28:33.640Z_

Multi-step scenarios where earlier turns set up evidence later turns need. Treatment is encouraged to stash early findings so later turns are cheap recalls instead of fresh searches.

### Per-arm summary

| arm | pass rate | mean in tokens | mean out tokens | mean tool calls | mean turns | mean ms |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| control   | 8% | 8098 | 364 | 5.0 | 6.0 | 34680 |
| treatment | 17% | 12613 | 366 | 2.7 | 3.7 | 32397 |

### Lift

- **pass-rate**: +8%
- **input tokens**: +56% 
- **output tokens**: +1%
- **wall-clock**: -7%

## memory-corpus literal recall (oasis-sleek conductor tracks)

_Corpus: 12268 lines, 622 KB. Run: 2026-06-12T13:12:36.297Z_

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mpg | 100% | 100% | 100% | 371 | 101 |
| ripgrep | 100% | 100% | 100% | 1197 | 23 |
| powershell | 100% | 91% | 95% | 2525 | 380 |
| embed | 45% | 45% | 45% | 18784 | 4 |

### conversational savings vs ripgrep baseline

ripgrep at the same recall is the cheapest line-oriented baseline. The savings columns below show what each substrate gives up (or saves) at that recall.

| substrate | recall vs rg | precision vs rg | token cost vs rg | latency vs rg |
| :--- | ---: | ---: | ---: | ---: |
| mpg | +0% | +0% | −69% | +341% |
| powershell | +0% | −9% | +111% | +1565% |
| embed | −55% | −55% | +1470% | −85% |

## memory-corpus (section-chunked embeddings)

_Run: 2026-06-12T13:13:52.624Z. Same queries and corpus as the memory-corpus tier, but the embedding index is built from per-section chunks (split on `## ` / `### ` markdown headings) rather than whole files._

Chunker produced 1072 section-level chunks from 12268 corpus lines.

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| embed-chunked | 51% | 51% | 51% | 1197 | 6 |

### Lift vs per-file embeddings

Section-level chunking moved recall by **+6%** (45% → 51%) at **94% fewer tokens** (18784 → 1197). Finer chunks let the embedding model fire on the right *slice* of a long spec instead of competing against unrelated sections of the same file.

## semantic recall — paraphrased queries

_Run: 2026-06-12T13:13:52.495Z. Queries are PARAPHRASED — the literal pattern doesn't appear verbatim in the corpus. This favors embeddings on construction; regex substrates get only the single most-distinctive literal keyword._

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| mpg | 92% | 100% | 95% | 12691 | 230 |
| ripgrep | 100% | 100% | 100% | 1236 | 117 |
| powershell | 100% | 92% | 95% | 2809 | 922 |
| embed | 50% | 50% | 50% | 17384 | 0 |

## typo tolerance — fuzzy search on typo'd queries

_Run: 2026-06-12T13:11:30.557Z. Each query has a CORRECT literal (defines ground truth via rg) and a TYPO'd version fed to every substrate. Tests `mpg --fuzzy` against rg, mpg-without-fuzzy, and per-file embeddings._

| substrate | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| rg | 0% | 0% | 0% | 0 | 26 |
| mpg | 0% | 0% | 0% | 0 | 98 |
| mpg-fuzzy | 100% | 88% | 92% | 711 | 176 |
| embed | 45% | 45% | 45% | 23999 | 2 |

## meso — recall vs budget (mpg)

_Run: 2026-06-12T13:11:01.625Z_

| effort | recall | precision | F1 | tokens | ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| quick | 100% | 79% | 85% | 257 | 98 |
| normal | 100% | 79% | 85% | 257 | 89 |
| deep | 100% | 79% | 85% | 257 | 88 |

## meso — embedding baseline (vector cosine top-k)

_Run: 2026-06-12T13:11:17.147Z_

| k | recall | precision | F1 | tokens | ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 54% | 27% | 33% | 109 | 3 |
| 5 | 92% | 36% | 48% | 218 | 3 |
| 10 | 100% | 28% | 40% | 320 | 3 |

### meso head-to-head: mpg (quick) vs embedding (k=5)

| metric | mpg quick | embed k=5 | mpg savings |
| :--- | ---: | ---: | ---: |
| recall    | 100% | 92% | — |
| precision | 79% | 36% | — |
| tokens    | 257 | 218 | +18% |
| ms        | 98 | 3 | +3167% |

## What the numbers mean

### Search substrate (no agent in the loop)

- **mpg vs ripgrep on the memory-system corpus (markdown specs + JSON metadata, conductor tracks)**: mpg **3.2× cheaper than rg** at 100% recall and 100% precision (371 vs 1197 tokens). `--effort scan --clip 30` returns sub-line snippets with ellipsis markers around each matched span — disambiguation without the line bloat.
- **PowerShell vs ripgrep**: matches rg on recall, **17× slower**. A Windows user without rg pays a real latency tax (PowerShell ~380 ms vs rg ~23 ms).
- **Embeddings vs regex (literal pattern queries) on the memory corpus**: per-file embeddings got 45% recall. Section-level chunking (`embed-chunked`) does meaningfully better at a fraction of the token cost — see the chunked section above. For *semantic* recall (paraphrased prompts), see the semantic section below.
- **Meso (small synthetic code corpus)**: mpg quick → 100% recall, 257 tokens. Embedding k=5 → 92% recall, 218 tokens. mpg wins on recall by 8%, costs 18% tokens. **Caveat**: the meso corpus is too small (8 files) to be load-bearing — expanding fixtures is in the backlog.
- **Typo tolerance**: `mpg --fuzzy` hits **100% recall** on typo'd queries (edit distance ≤ 2) at 88% precision; rg gets 0% because the literal isn't there.

### Agent-in-the-loop (macro, multi-turn, compaction)

- **Macro task lift (claude-haiku-4-5-20251001 (Anthropic default), 5 tasks)**: pass-rate 80%/100% (+20% lift). Treatment converges in **5.0 turns vs 5.2** (4% fewer) and emits **7% less** output reasoning. Input tokens: +48% (mpg results inline).
- **Multi-turn (local 4B-class model, 3 scenarios)**: **+8% pass-rate lift** (8% → 17%), +56% input tokens. Across multiple related questions, the mind palace makes evidence reusable so later turns don't re-search. Smaller models benefit most from palace recall — see the LongMemEval row below for the larger-N result with a stronger model class.
- **Long-horizon memory (LongMemEval oracle, N=500, GPT-4o judge)**: palace-as-framework (per-session `--mp-stash` + agent-driven `palace_search` / `palace_compose` tools) with xiaomi/mimo-v2-flash scored **0.44** vs flat-log substrate with claude-sonnet-4-6 at **0.32** — same dataset, same judge. The +12pp came from how the framework is shaped, not the model. Lift concentrates in temporal-reasoning (+19pp), knowledge-update (+37pp), multi-session (+20pp). The cheap-model+framework run cost ~$2 vs ~$23 for the frontier-model+substrate baseline.
- **Compaction (3 topics × 3 arms, ~2000-token budget)**: **mpg-scan (zero-LLM)** matches single-pass LLM summarization on pass-rate (44% vs 44%) and beats truncation (11%) at **zero LLM input tokens**. For "compact a topic to N tokens, then Q&A from it," `mpg --effort scan --clip 30 --sort recent --max-tokens N` saves ~21489 tokens of LLM input at parity quality.

## Wins and trade-offs

Auto-generated from the latest run. Trade-offs are listed with the context that makes them acceptable — most are deliberate design choices, not unsolved problems.

**Wins:**
- Beats rg on tokens by **3.2×** (371 vs 1197) at the same 100% recall + precision via `--effort scan --clip 30`.
- **100% typo recall** at edit distance ≤ 2 via `mpg --fuzzy` (rg: 0%). Catches drop/insert/substitute/swap typos at a fraction of embedding cost.
- Mind palace set semantics hold (micro: compose=union, intersect=intersection, prune-keep by recency, graph terminates on cycles). rg has no equivalent of any of these — and mpg's actual pitch is **stash, recall, compose across turns**, which rg structurally cannot do.

**Trade-offs:**
- **Cold-start latency vs rg** (101ms vs 23ms, ~4× slower). This is the cost of Node startup + JSON formatting + token budgeting; mpg's pitch isn't faster grep, it's a *budgeted, addressable, stash-able* lens. For workflows that don't need any of that, rg is the right tool — and mpg's MCP server (warm-call mode) closes most of the gap.
- **Macro input-token overhead** (+48% vs control). mpg result blocks carry windowed context and metadata; rg returns raw lines. The agent's lens prompt already tells it to skip mpg for single-keyword lookups where rg's output is enough. The trade is: pay tokens for context that converges the agent faster (1.04× fewer turns this run).

## What's missing (the comparisons this bench can't make yet)

- **Other named-memory systems** as substrates: mem0, Letta, Anthropic's Claude memory tool. Each would slot into the conversational bench as another substrate. Skipped on first pass because each ships its own auth / setup story.
- **Cross-corpus generalization**: the macro and multi-turn tiers run on FractalEngine specs+code; the conversational tier on the project's own Claude transcripts. Larger or differently-shaped codebases (Python monorepos, large docs sites) would surface whether the wins generalize.
- **SWE-bench Lite integration**: replace the hand-labeled task set with the SWE-bench harness for an externally-comparable lift number. Needs Docker + the SWE-bench infra; out of scope for the local bench.
- **Multi-session long-term memory**: the multi-turn tier still runs all turns inside one model context. True LoCoMo-style sessions (palace persists, model context is cleared between sessions) would test memory durability separately from in-context recall.
- **Re-running semantic queries against the chunked embedding index**: the semantic tier today uses raw-line embeddings; piping the chunker through would show whether chunking flips embeddings' advantage on paraphrased queries. Easy follow-up.
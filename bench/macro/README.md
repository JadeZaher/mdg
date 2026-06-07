# Macro: agent task lift (scaffold + methodology)

This is the only benchmark that tells you whether mdg actually helps
real work. It is also the most expensive and the only one that needs
external infrastructure (Docker, the SWE-bench harness, model API keys,
a test-of-record).

## What "task lift" means

Run the same agent harness against the same task set, twice:

1. **Control** — agent has built-in tools only (read, grep, write,
   bash). No mdg.
2. **Treatment** — same agent, same model, same budget, plus mdg MCP
   tools registered.

Score each task with a binary did-it-pass-the-hidden-tests metric. Lift
is `pass_rate(treatment) - pass_rate(control)`. Secondary metrics:

- mean total tokens per task (less is better)
- mean wall-clock per task
- mean tool calls per task

A 5-point lift on pass-rate at the same or lower token cost is the
result that justifies recommending mdg. Anything less is a wash.

## Task sets

Pick one — don't try to do all three at once.

### SWE-bench Lite (recommended baseline)

- 300 real GitHub issues from 12 popular Python projects, with hidden
  unit tests.
- Public harness: https://www.swebench.com/
- Lite subset (~25% of full) is cheap enough for a few-hour run.
- Pro: every result is comparable to published numbers for other
  agentic tools.
- Con: Python-only, repo-bound, doesn't exercise mdg's `--cmd` / `--url`
  source types.

### Curated GitHub issues (your own projects)

- 30 hand-picked closed issues from JadeZaher/* repos.
- Ground truth = the actual merged fix.
- Pro: matches the kinds of tasks you actually do; multi-language; can
  include `--cmd` / `--url` queries.
- Con: not comparable to anything external; needs hand-grading.

### Synthetic multi-step recall

- A scripted multi-turn task where the agent has to:
  1. Find a pattern across the codebase.
  2. Stash it.
  3. In a later turn, recall it without re-searching.
  4. Compose with a second pattern.
  5. Produce a final answer that requires both.
- Pro: directly stress-tests mdg's memory contribution.
- Con: synthetic — doesn't tell you about real-world ergonomics.

## What goes in this directory

When implemented, this folder should contain:

- `runner.ts` — driver that boots two agents (control + treatment) per
  task, collects logs, scores.
- `agent/` — minimal agent harness (tool loop, model adapter). Could
  use Anthropic SDK directly so it's reproducible.
- `tasks/` — task set definitions. For SWE-bench, this is a thin
  pointer to the upstream `swebench` package.
- `score.ts` — pass-rate + token + wall-clock aggregator.
- `results/` — per-run JSON, one per (task, condition) cell.

## Cost guardrails

- **Cap tokens per task.** A 30-task run × 2 conditions × 50k tokens
  cap is 3M tokens. At Sonnet pricing that's a few dollars.
- **Pin the model.** Use a single model ID throughout a run. Don't
  compare runs across model versions.
- **Set a wall-clock cap per task** (e.g. 5 min). Agents that loop
  burn the budget.
- **Save intermediate state.** Re-running a failed task is cheap;
  re-running the whole sweep isn't.

## When to run this

- Before publishing a new mdg version with a behavioral change.
- After a meaningful skill prompt rewrite (the skill *is* part of the
  treatment — changing it changes the result).
- Before recommending mdg as a default in someone else's harness.

## Until then

The micro + meso benchmarks tell you nothing about real-world lift,
but they do catch regressions cheaply. Run those on every commit.
Run macro quarterly or before a release.

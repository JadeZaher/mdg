"""Post-hoc miss analyzer for longmemeval traces.

Usage:
    python scripts/analyze_misses.py results/longmemeval/mpg/<model>/<ts>/trace.jsonl

Walks a trace.jsonl and categorizes every miss (score=0) into:
  - refusal      : agent declined to answer ("no info", "cannot find")
  - wrong_fact   : agent picked a wrong specific value
  - date_math    : retrieval surfaced both anchors but arithmetic is wrong
  - empty_hits   : retrieval returned 0 nodes — adapter-side miss
  - judge_quirk  : judge's raw response disagrees with the verdict mapping
  - other

Also prints a per-retrieval-strategy breakdown (default / literal / two_pass)
when present (newer traces); falls back gracefully on older traces.

The script never modifies anything; safe to run against an in-flight trace
(jsonl is line-append; we only read complete lines).
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


_REFUSAL_RE = re.compile(
    r"\b(i (?:do not|don't) have|no (?:information|record|mention|detail)|"
    r"cannot find|not enough|excerpts? (?:do not|don't) (?:contain|mention)|"
    r"unable to (?:determine|answer|find)|the (?:provided )?excerpts? do not)\b",
    re.IGNORECASE,
)


def _is_refusal(text: str) -> bool:
    return bool(_REFUSAL_RE.search(text or ""))


def _looks_like_date_math(question: str) -> bool:
    q = question.lower()
    return (
        ("how many days" in q or "how many weeks" in q or "how many months" in q)
        and (" between " in q or " from " in q)
    )


def _looks_like_polarity(question: str) -> bool:
    q = question.lower()
    return any(p in q for p in (
        "which event first", "which item", "which task", "which device",
        "which pair", "which vehicle", "which seeds", "which book",
    )) and (" first" in q or " or " in q)


def _judge_quirk(rec: dict) -> bool:
    raw = rec.get("judge_raw") or ""
    if not raw:
        return False
    matches = re.findall(r"\b(yes|no)\b", raw, re.IGNORECASE)
    if not matches:
        return False
    judge_says_yes = matches[-1].lower() == "yes"
    return judge_says_yes != (rec.get("score", 0.0) == 1.0)


def _classify_miss(rec: dict) -> str:
    if rec.get("n_hits", 0) == 0:
        return "empty_hits"
    if rec.get("looks_like_refusal") is True:
        return "refusal"
    if _is_refusal(rec.get("candidate", "")):
        return "refusal"
    if _judge_quirk(rec):
        return "judge_quirk"
    if _looks_like_date_math(rec.get("question", "")):
        return "date_math"
    if _looks_like_polarity(rec.get("question", "")):
        return "wrong_fact"
    return "other"


def _summarize_strategies(records: list[dict]) -> dict:
    """Per-strategy hit/miss counts. Works with old traces (no retrieval_meta)
    by lumping everything into "unknown"."""
    by_strat: dict[str, dict] = defaultdict(lambda: {"hit": 0, "miss": 0})
    for r in records:
        strat = (r.get("retrieval_meta") or {}).get("strategy", "unknown")
        bucket = "hit" if r["score"] == 1.0 else "miss"
        by_strat[strat][bucket] += 1
    return dict(by_strat)


def _percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round(p * (len(s) - 1)))))
    return s[idx]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    if not path.exists():
        print(f"Trace not found: {path}", file=sys.stderr)
        return 2

    records: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # Partial last line on in-flight trace — skip.
                continue

    if not records:
        print("No records.")
        return 0

    total = len(records)
    correct = sum(1 for r in records if r["score"] == 1.0)
    print(f"Trace: {path}")
    print(f"Episodes: {total}  Correct: {correct}  Mean: {correct/total:.3f}")

    # Per-question-type.
    by_type: dict[str, list[float]] = defaultdict(list)
    for r in records:
        by_type[r.get("question_type", "unknown")].append(r["score"])
    print("\nPer question-type:")
    for qt, scs in sorted(by_type.items()):
        print(f"  {qt:<28} {sum(scs)/len(scs):.3f} ({int(sum(scs)):d}/{len(scs):d})")

    # Per-retrieval-strategy.
    by_strat = _summarize_strategies(records)
    if by_strat:
        print("\nPer retrieval strategy:")
        for strat, c in sorted(by_strat.items()):
            tot = c["hit"] + c["miss"]
            pct = (c["hit"] / tot * 100) if tot else 0.0
            print(f"  {strat:<14} hit={c['hit']:>4d} miss={c['miss']:>4d} ({pct:.0f}%)")

    # Miss categorization.
    misses = [r for r in records if r["score"] == 0.0]
    cats = Counter(_classify_miss(r) for r in misses)
    print(f"\nMiss categories ({len(misses)} total):")
    for cat, n in cats.most_common():
        print(f"  {cat:<14} {n:>4d}")

    # Latency.
    ms = [int(r["episode_ms"]) for r in records if isinstance(r.get("episode_ms"), int)]
    if ms:
        print(
            f"\nLatency (ms): p50={_percentile(ms,0.5)} "
            f"p95={_percentile(ms,0.95)} max={max(ms)}"
        )

    # Judge-quirk samples.
    quirks = [r for r in misses if _judge_quirk(r)]
    if quirks:
        print(f"\nJudge-quirk samples ({len(quirks)}):")
        for r in quirks[:5]:
            print(f"  Q: {r['question'][:80]}")
            print(f"  REF: {str(r['reference'])[:60]}")
            print(f"  A:   {str(r['candidate'])[:80]}")
            print(f"  judge_raw: {str(r.get('judge_raw',''))[:120]}")
            print()

    # Sample of refusals + wrong-facts.
    for cat in ("refusal", "wrong_fact", "date_math"):
        samples = [r for r in misses if _classify_miss(r) == cat][:3]
        if not samples:
            continue
        print(f"\n{cat} samples ({len(samples)} of {cats[cat]}):")
        for r in samples:
            print(f"  Q: {r['question'][:90]}")
            print(f"  REF: {str(r['reference'])[:60]}")
            print(f"  A:   {str(r['candidate'])[:90]}")
            meta = r.get("retrieval_meta") or {}
            if meta:
                print(f"  retrieval: {meta}")
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

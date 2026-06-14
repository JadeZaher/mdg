"""Re-grade an existing benchmark trace with a different judge model.

Usage:
    python scripts/regrade.py --trace results/.../trace.jsonl --judge gemma-4-e2b

Writes results to <trace_dir>/regrade_<judge>.json with the same shape as
the original results.json so it's drop-in comparable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def main() -> None:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    # Reuse the harness's env auto-loader so ANTHROPICAPIKEY /
    # OPENROUTER_API_KEY pick up automatically from the sibling repo.
    from harness.run import _load_sibling_env
    _load_sibling_env()
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace", required=True, help="Path to trace.jsonl")
    parser.add_argument("--judge", required=True, help="Model preset name")
    parser.add_argument("--limit", type=int, default=None, help="Optional cap on episodes to regrade.")
    parser.add_argument("--delay-ms", type=int, default=0, help="Inter-call delay for rate-limited hosted judges.")
    args = parser.parse_args()

    trace_path = Path(args.trace)
    if not trace_path.exists():
        sys.exit(f"trace not found: {trace_path}")

    preset_path = Path(__file__).parent.parent / "configs" / "models" / f"{args.judge}.yaml"
    if not preset_path.exists():
        sys.exit(f"judge preset not found: {preset_path}")

    import yaml
    from harness.model_client import from_config
    from benches.longmemeval.runner import _grade

    judge_cfg = yaml.safe_load(preset_path.read_text(encoding="utf-8"))
    judge = from_config(judge_cfg)

    rows = [json.loads(l) for l in trace_path.open(encoding="utf-8")]
    new_scores: list[float] = []
    per_type: dict[str, list[float]] = {}
    out_rows: list[dict] = []

    t0 = time.time()
    if args.limit is not None:
        rows = rows[: args.limit]
    for i, row in enumerate(rows):
        result = _grade(judge, row["question"], row["reference"], row["candidate"])
        # _grade may return bool (old) or (bool, raw) (new); duck-type both.
        if isinstance(result, tuple):
            correct, judge_raw = result
        else:
            correct, judge_raw = bool(result), ""
        s = 1.0 if correct else 0.0
        new_scores.append(s)
        per_type.setdefault(row.get("question_type", "unknown"), []).append(s)
        out_rows.append({
            **row,
            "score_original": row["score"],
            "score_regrade": s,
            "judge_raw_regrade": judge_raw,
        })
        if i % 20 == 0 or i == len(rows) - 1:
            running = sum(new_scores) / len(new_scores)
            print(f"  ep{i:>3} orig={int(row['score'])} new={int(s)}  running_mean={running:.3f}")
        if args.delay_ms > 0 and i < len(rows) - 1:
            time.sleep(args.delay_ms / 1000.0)

    elapsed = time.time() - t0
    summary = {
        "judge": args.judge,
        "n": len(new_scores),
        "mean": sum(new_scores) / len(new_scores) if new_scores else 0.0,
        "mean_original": sum(r["score"] for r in rows) / len(rows) if rows else 0.0,
        "elapsed_sec": elapsed,
        "per_type": {qt: sum(xs) / len(xs) for qt, xs in per_type.items()},
    }
    out_path = trace_path.parent / f"regrade_{args.judge}.json"
    out_path.write_text(json.dumps({"summary": summary, "rows": out_rows}, indent=2), encoding="utf-8")
    print()
    print(f"original mean: {summary['mean_original']:.3f}")
    print(f"regrade  mean: {summary['mean']:.3f}  ({(summary['mean']-summary['mean_original'])*100:+.1f} pp)")
    print(f"written: {out_path}")


if __name__ == "__main__":
    os.environ.setdefault("OPENAI_API_KEY", "lm-studio")
    main()

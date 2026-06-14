"""Pretty-print a single per-episode artifact.

Usage:
    python scripts/show_episode.py results/.../episodes/0003-some_qid.json
    python scripts/show_episode.py results/.../episodes/ --miss --limit 5

Shows everything the runner saw at scoring time — agent prompts (no
truncation), retrieval hits, agent answer, judge prompts, judge raw
response, verdict. Designed for ergonomic post-hoc debugging.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Force UTF-8 stdout on Windows so artifacts that contain real names with
# accents / em-dashes don't crash on cp1252 print.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass


def _wrap(label: str, body: str) -> str:
    sep = "─" * 78
    return f"\n┌{sep[1:]}\n│ {label}\n├{sep[1:]}\n{body.rstrip()}\n└{sep[1:]}"


def _read_or_inline(art: dict, section: str, file_key: str, inline_key: str) -> str:
    """schema_version 2 stores big blobs as separate text files referenced
    by `*_file` keys. schema_version 1 inlined them under `system_prompt`
    etc. This helper supports both."""
    sec = art.get(section, {})
    rel = sec.get(file_key)
    if rel:
        ep_dir = Path(art["__artifact_path__"]).parent
        p = ep_dir / rel
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace")
    return sec.get(inline_key, "")


def show(art: dict, *, max_hits: int = 0) -> str:
    lines: list[str] = []
    lines.append(f"# Episode {art['i']}  ({art['question_id']})")
    lines.append(f"  type: {art['question_type']}    score: {art['score']}    refusal? {art.get('looks_like_refusal')}")
    lines.append(f"  date: {art.get('question_date','')}    episode_ms: {art.get('episode_ms','?')}")
    rm = art.get("retrieval", {}).get("strategy_meta", {})
    lines.append(f"  retrieval: {rm}")
    lines.append(_wrap("QUESTION", art["question"]))
    lines.append(_wrap("REFERENCE (ground truth)", str(art["reference"])))
    agent = art.get("agent", {})
    agent_sys = _read_or_inline(art, "agent", "system_prompt_file", "system_prompt")
    agent_usr = _read_or_inline(art, "agent", "user_prompt_file", "user_prompt")
    agent_ans = _read_or_inline(art, "agent", "answer_file", "answer")
    lines.append(_wrap(f"AGENT [{agent.get('model','?')}] system_prompt", agent_sys))
    lines.append(_wrap(f"AGENT [{agent.get('model','?')}] user_prompt", agent_usr))
    lines.append(_wrap(f"AGENT [{agent.get('model','?')}] answer", agent_ans))

    retr = art.get("retrieval", {})
    trace = retr.get("trace") or []
    if max_hits:
        trace = trace[:max_hits]
    if trace:
        body = []
        for j, t in enumerate(trace):
            if t.get("type") == "retrieval":
                body.append(f"[{j}] {t.get('source','')}")
                body.append(t.get("text", ""))
                body.append("")
            else:
                body.append(f"[{j}] {t.get('type','')} {json.dumps({k:v for k,v in t.items() if k != 'type'}, ensure_ascii=False)[:1200]}")
        lines.append(_wrap(f"RETRIEVAL hits (n={retr.get('n_hits',len(trace))})", "\n".join(body)))

    # v2: mpg calls + tool calls if present.
    retr = art.get("retrieval", {})
    for cf in (retr.get("mpg_call_files") or []):
        ep_dir = Path(art["__artifact_path__"]).parent
        p = ep_dir / cf
        if p.exists():
            lines.append(_wrap(f"MPG CALL  {cf}", p.read_text(encoding="utf-8", errors="replace")))
    if retr.get("tool_calls_file"):
        ep_dir = Path(art["__artifact_path__"]).parent
        p = ep_dir / retr["tool_calls_file"]
        if p.exists():
            lines.append(_wrap("TOOL CALLS", p.read_text(encoding="utf-8", errors="replace")))
    # v2 hits file fallback if no trace inline.
    hits_file = retr.get("hits_file")
    if hits_file and not (art.get("retrieval", {}).get("trace") or []):
        ep_dir = Path(art["__artifact_path__"]).parent
        p = ep_dir / hits_file
        if p.exists():
            lines.append(_wrap(f"RETRIEVAL hits (file: {hits_file})", p.read_text(encoding="utf-8", errors="replace")))

    judge = art.get("judge", {})
    judge_sys = _read_or_inline(art, "judge", "system_prompt_file", "system_prompt")
    judge_usr = _read_or_inline(art, "judge", "user_prompt_file", "user_prompt")
    judge_raw = _read_or_inline(art, "judge", "raw_response_file", "raw_response")
    lines.append(_wrap(f"JUDGE [{judge.get('model','?')}] system_prompt", judge_sys))
    lines.append(_wrap(f"JUDGE [{judge.get('model','?')}] user_prompt", judge_usr))
    lines.append(_wrap(f"JUDGE [{judge.get('model','?')}] raw_response", judge_raw))
    lines.append(f"  verdict_yes: {judge.get('verdict_yes')}    final score: {art.get('score')}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", help="Episode artifact file OR an episodes/ directory")
    parser.add_argument("--miss", action="store_true", help="Only show score=0 episodes (directory mode)")
    parser.add_argument("--hit", action="store_true", help="Only show score=1 episodes (directory mode)")
    parser.add_argument("--type", help="Filter by question_type (directory mode)")
    parser.add_argument("--limit", type=int, default=0, help="Cap output count (directory mode)")
    parser.add_argument("--max-hits", type=int, default=0, help="Cap retrieval trace lines shown")
    args = parser.parse_args(argv[1:])

    p = Path(args.path)
    if not p.exists():
        print(f"Not found: {p}", file=sys.stderr)
        return 2

    # Accept any of:
    #   - a single artifact.json file
    #   - a single episode dir (containing artifact.json)        [v2]
    #   - the parent episodes/ dir (containing per-episode dirs) [v2]
    #   - the parent episodes/ dir (containing flat *.json)      [v1]
    files: list[Path]
    if p.is_file():
        files = [p]
    else:
        v2_artifacts = sorted(p.glob("*/artifact.json"))
        v2_self = [p / "artifact.json"] if (p / "artifact.json").exists() else []
        v1_flat = sorted(p.glob("*.json"))
        files = v2_artifacts or v2_self or v1_flat

    shown = 0
    for f in files:
        try:
            art = json.loads(f.read_text(encoding="utf-8"))
            art["__artifact_path__"] = str(f)
        except Exception as e:
            print(f"# skip {f.name}: {e}")
            continue
        if args.miss and art.get("score", 0) != 0.0:
            continue
        if args.hit and art.get("score", 0) != 1.0:
            continue
        if args.type and art.get("question_type") != args.type:
            continue
        print(show(art, max_hits=args.max_hits))
        print()
        shown += 1
        if args.limit and shown >= args.limit:
            break
    if p.is_dir():
        print(f"\n(showed {shown} of {len(files)} artifacts)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

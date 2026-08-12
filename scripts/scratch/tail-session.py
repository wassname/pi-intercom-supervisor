#!/usr/bin/env python3
"""Compact tail of a pi session jsonl, so a live run can be read without a paste. -- CLAUDE

usage: tail-session.py <session-id-prefix> [n_turns]
"""
import glob
import json
import sys

SESSIONS = "/home/wassname/.pi/agent/sessions/*/*.jsonl"


def render(msg, width):
    role = msg.get("role")
    content = msg.get("content")
    if isinstance(content, str):
        return [(role, content[:width])]
    out = []
    for b in content or []:
        t = b.get("type")
        if t == "text" and b.get("text", "").strip():
            out.append((role, b["text"].strip()[:width]))
        elif t == "thinking" and b.get("thinking", "").strip():
            out.append(("thinking", b["thinking"].strip()[-width:]))
        elif t == "toolCall":
            args = json.dumps(b.get("arguments", {}))[:width]
            out.append(("CALL " + str(b.get("name")), args))
    if role == "toolResult":
        body = " ".join(x for _, x in out) or "(no output)"
        return [("  -> " + str(msg.get("toolName")) + (" ERROR" if msg.get("isError") else ""), body[:width])]
    return out


def main():
    prefix, n = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 25
    hits = [f for f in glob.glob(SESSIONS) if prefix in f]
    if len(hits) != 1:
        sys.exit(f"want exactly 1 session matching {prefix}, got {len(hits)}: {hits}")
    entries = [json.loads(line) for line in open(hits[0])]
    print(f"# {hits[0].split('/')[-1]}  ({len(entries)} entries)")
    rows = []
    for e in entries:
        if e.get("type") != "message" or not e.get("message"):
            continue
        for who, text in render(e["message"], 400):
            rows.append((e.get("timestamp", "")[11:19], who, text))
    for ts, who, text in rows[-n:]:
        print(f"{ts} {who}: {text}")


main()

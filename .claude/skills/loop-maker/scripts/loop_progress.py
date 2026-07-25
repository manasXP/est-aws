#!/usr/bin/env python3
"""loop-maker terminal UX renderer — progress bar, phase breadcrumb, blueprint box.

Pure stdlib, prints to stdout, so the wizard looks identical on any host
(Claude Code, Codex, Hermes, OpenClaw). The model could hand-draw these, but a
single Python pass is faster and never miscounts box-drawing cells.
"""
from __future__ import annotations

import sys
import unicodedata

PHASES = ["elicit", "survey", "select", "scaffold"]
PHASE_GLYPH = {"elicit": "🎙", "survey": "🔎", "select": "🎯", "scaffold": "🏗"}
BOX_WIDTH = 50  # inner content width for blueprint_box


def _vwidth(s: str) -> int:
    w = 0
    for c in s:
        if unicodedata.category(c) == "Mn" or ord(c) == 0xFE0F:
            continue
        if unicodedata.east_asian_width(c) in ("W", "F") or ord(c) >= 0x1F000:
            w += 2
        else:
            w += 1
    return w


def progress_bar(current: int, total: int, width: int = 7) -> str:
    if total <= 0:
        filled, pct = width, 100
    else:
        pct = int(round(100 * current / total))
        filled = int(round(width * current / total))
    bar = "▓" * filled + "░" * (width - filled)
    return f"Q{current}/{total}  {bar}  {pct}%"


def phase_breadcrumb(current: str) -> str:
    if current not in PHASES:
        raise ValueError(f"unknown phase: {current!r} (expected one of {PHASES})")
    chain = "  →  ".join(f"{PHASE_GLYPH[p]} {p}" for p in PHASES)
    return f"{chain}\n(you are here: {PHASE_GLYPH[current]} {current})"


def blueprint_box(fields, title: str = "LOOP BLUEPRINT") -> str:
    head = f"┌─ {title} "
    top = head + "─" * (BOX_WIDTH + 3 - _vwidth(head)) + "┐"
    lines = [top]
    for label, value in fields:
        body = f"{label:<9} {value}"
        pad = BOX_WIDTH - _vwidth(body)
        lines.append("│ " + body + (" " * max(pad, 0)) + " │")
    lines.append("└" + "─" * (BOX_WIDTH + 2) + "┘")
    return "\n".join(lines)


def _main(argv) -> int:
    if not argv:
        print("usage: loop_progress.py bar N M | breadcrumb PHASE | blueprint K V [K V ...]", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "bar":
        print(progress_bar(int(rest[0]), int(rest[1])))
    elif cmd == "breadcrumb":
        print(phase_breadcrumb(rest[0]))
    elif cmd == "blueprint":
        pairs = list(zip(rest[0::2], rest[1::2]))
        print(blueprint_box(pairs))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))

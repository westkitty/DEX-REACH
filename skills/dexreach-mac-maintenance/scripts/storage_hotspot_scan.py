#!/usr/bin/env python3
"""Bounded, read-only hotspot scan for one explicitly selected directory root."""
from __future__ import annotations

import argparse
import json
import os
import stat
import time
from pathlib import Path


def is_symlink(path: Path) -> bool:
    try:
        return stat.S_ISLNK(path.lstat().st_mode)
    except OSError:
        return False


def scan(root: Path, max_depth: int, top: int, seconds: float, entry_limit: int) -> dict:
    root = root.expanduser().absolute()
    started = time.monotonic()
    if not root.exists() or not root.is_dir() or is_symlink(root):
        raise SystemExit("root must be an existing non-symlink directory")

    totals: dict[str, int] = {}
    visited = 0
    partial = False
    stack: list[tuple[Path, int, str | None]] = [(root, 0, None)]

    while stack:
        if time.monotonic() - started >= seconds or visited >= entry_limit:
            partial = True
            break
        current, depth, bucket = stack.pop()
        try:
            entries = list(os.scandir(current))
        except (OSError, PermissionError):
            continue
        for entry in entries:
            visited += 1
            if time.monotonic() - started >= seconds or visited >= entry_limit:
                partial = True
                break
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                continue
            p = Path(entry.path)
            rel = p.relative_to(root)
            top_name = rel.parts[0] if rel.parts else p.name
            use_bucket = bucket or top_name
            if stat.S_ISREG(st.st_mode):
                totals[use_bucket] = totals.get(use_bucket, 0) + int(st.st_size)
            elif stat.S_ISDIR(st.st_mode) and depth < max_depth:
                stack.append((p, depth + 1, use_bucket))
        if partial:
            break

    ranked = sorted(totals.items(), key=lambda x: (-x[1], x[0].lower()))[:top]
    return {
        "root": str(root),
        "max_depth": max_depth,
        "visited_entries": visited,
        "seconds_limit": seconds,
        "entry_limit": entry_limit,
        "partial": partial,
        "hotspots": [{"name": name, "bytes": size} for name, size in ranked],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--max-depth", type=int, default=2)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--entry-limit", type=int, default=100000)
    args = ap.parse_args()
    if not 0 <= args.max_depth <= 4:
        ap.error("--max-depth must be 0..4")
    if not 1 <= args.top <= 100:
        ap.error("--top must be 1..100")
    print(json.dumps(scan(Path(args.root), args.max_depth, args.top, args.seconds, args.entry_limit), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

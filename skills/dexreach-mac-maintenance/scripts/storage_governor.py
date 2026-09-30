"""Bounded Storage Guardian primitives owned by DEX//MAINT.

This module deliberately has no command line entry point and no independent
mutation authority.  ``dexmaint_remote.py`` calls it from a locked manifest.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

GIB = 1024 ** 3
PRESSURE = ((30 * GIB, "HEALTHY"), (20 * GIB, "WATCH"), (10 * GIB, "LOW"), (5 * GIB, "CRITICAL"), (0, "EMERGENCY"))
OBSERVATION_FILE = "storage-observations.jsonl"
RECEIPT_FILE = "reclaim-receipts.jsonl"
LOCK_FILE = "watch.lock"
_SIZE_DEADLINE: float | None = None


def reset_size_budget(seconds: float | None) -> None:
    global _SIZE_DEADLINE
    _SIZE_DEADLINE = time.monotonic() + seconds if seconds is not None else None


def pressure_state(immediately_free_bytes: int) -> str:
    for minimum, name in PRESSURE:
        if immediately_free_bytes >= minimum:
            return name
    return "EMERGENCY"


def age_seconds(path: Path, now: float | None = None) -> float:
    try:
        return max(0.0, (now if now is not None else time.time()) - path.stat().st_mtime)
    except OSError:
        return 0.0


def under(path: Path, root: Path) -> bool:
    try:
        path.absolute().relative_to(root.absolute())
        return True
    except ValueError:
        return False


def safe_size(path: Path) -> int:
    try:
        st = path.lstat()
    except OSError:
        return 0
    if stat.S_ISLNK(st.st_mode):
        return 0
    if stat.S_ISREG(st.st_mode):
        return st.st_size
    if not stat.S_ISDIR(st.st_mode):
        return 0
    remaining = 5.0 if _SIZE_DEADLINE is None else _SIZE_DEADLINE - time.monotonic()
    if remaining <= 0:
        return -1
    try:
        measured = subprocess.run(["du", "-sk", "-x", str(path)], text=True,
                                  capture_output=True, timeout=min(5.0, remaining), check=False)
        if measured.returncode != 0:
            return -1
        return int(measured.stdout.split()[0]) * 1024
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return -1


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def history(path: Path, limit: int = 4096) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines()[-limit:]:
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
    except (OSError, json.JSONDecodeError):
        return []
    return rows


def growth(current: dict[str, int], rows: list[dict[str, Any]], now: dt.datetime) -> dict[str, dict[str, int | None]]:
    result: dict[str, dict[str, int | None]] = {}
    for category, size in current.items():
        value: dict[str, int | None] = {"current_bytes": size, "growth_24h_bytes": None, "growth_7d_bytes": None, "peak_observed_bytes": size}
        samples = [r for r in rows if r.get("category") == category and isinstance(r.get("bytes"), int)]
        if samples:
            value["peak_observed_bytes"] = max(size, max(int(r["bytes"]) for r in samples))
        for key, seconds in (("growth_24h_bytes", 86400), ("growth_7d_bytes", 604800)):
            eligible = []
            for row in samples:
                try:
                    seen = dt.datetime.fromisoformat(str(row["observed_at"]).replace("Z", "+00:00"))
                    if (now - seen).total_seconds() >= seconds:
                        eligible.append(row)
                except (KeyError, ValueError, TypeError):
                    pass
            if eligible:
                baseline = max(eligible, key=lambda r: str(r.get("observed_at")) )
                value[key] = size - int(baseline["bytes"])
        result[category] = value
    return result


def record_observations(state: Path, run_id: str, candidates: list[dict[str, Any]], immediately_free: int) -> dict[str, Any]:
    file = state / OBSERVATION_FILE
    rows = history(file)
    now = dt.datetime.now(dt.timezone.utc)
    current = {str(c["category"]): int(c.get("bytes", 0)) for c in candidates}
    report = growth(current, rows, now)
    for category, size in current.items():
        append_jsonl(file, {"observed_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"), "run_id": run_id, "category": category, "bytes": size, "immediately_free_bytes": immediately_free})
    alerts = []
    for category, values in report.items():
        if (values["growth_24h_bytes"] or 0) > GIB:
            alerts.append({"category": category, "reason": "growth exceeds 1 GiB in 24h"})
        current_bytes = int(values["current_bytes"])
        seven = values["growth_7d_bytes"]
        if seven is not None and current_bytes > 0 and seven >= current_bytes // 2:
            alerts.append({"category": category, "reason": "size doubled within 7d"})
    return {"growth": report, "alerts": alerts}


def deleted_open(run: Callable[[list[str], int], tuple[int, str, str]]) -> dict[str, Any]:
    """Aggregate lsof +L1 by process and inode; a failure is explicitly unknown."""
    if shutil.which("lsof") is None:
        return {"state": "unavailable", "pinned_bytes": None, "owners": []}
    rc, out, _ = run(["lsof", "-nP", "+L1", "-Fpcfsin"], 20)
    if rc not in {0, 1}:
        return {"state": "unavailable", "pinned_bytes": None, "owners": []}
    pid = command = inode = name = None
    file_size: int | None = None
    seen: set[tuple[str, str]] = set()
    owners: dict[str, int] = {}
    for line in out.splitlines():
        if not line:
            continue
        key, value = line[0], line[1:]
        if key == "p": pid = value
        elif key == "c": command = value
        elif key == "f": inode = name = None; file_size = None
        elif key == "s":
            try: file_size = int(value)
            except ValueError: file_size = None
        elif key == "i": inode = value
        elif key == "n":
            name = value
            if file_size is None: continue
            identity = (pid or "?", inode or name or "?")
            if identity in seen: continue
            seen.add(identity)
            owner = f"{pid or '?'}:{command or 'unknown'}"
            owners[owner] = owners.get(owner, 0) + file_size
    ranked = [{"owner": owner, "bytes": amount} for owner, amount in sorted(owners.items(), key=lambda x: -x[1])[:10]]
    return {"state": "complete", "pinned_bytes": sum(owners.values()), "owners": ranked, "reboot_recommended": sum(owners.values()) >= GIB}


def report_only(path: Path, category: str, reason: str) -> dict[str, Any] | None:
    if not path.exists() or path.is_symlink(): return None
    return {"category": category, "path": str(path), "bytes": max(0, safe_size(path)), "disposition": "REPORT_ONLY", "regeneration": "unknown", "active": False, "reason": reason, "kind": "governor", "adapter": "report-only"}


def known_hotspots(home: Path, open_state: Callable[[Path], bool | None], active: Callable[[list[str]], bool]) -> list[dict[str, Any]]:
    """Exact, bounded candidates. Unknown activity is protected, never assumed safe."""
    reset_size_budget(20.0)
    output: list[dict[str, Any]] = []
    def child_candidates(root: Path, category: str, disposition: str, markers: list[str], retention: int, adapter: str, reason: str) -> None:
        if not root.exists() or root.is_symlink(): return
        for item in sorted(root.iterdir(), key=lambda p: p.name):
            if item.is_symlink() or age_seconds(item) < retention: continue
            opened = open_state(item)
            is_active = active(markers) if markers else False
            measured_size = safe_size(item)
            status = disposition if opened is False and not is_active and measured_size >= 0 else "PROTECTED"
            output.append({"category": category, "path": str(item), "bytes": max(0, measured_size), "disposition": status, "regeneration": "reconstructable", "active": bool(opened) or is_active, "reason": reason if status == disposition else "size, live-use, or open-handle check failed", "kind": "governor", "adapter": adapter, "retention_seconds": retention})
    child_candidates(Path("/opt/homebrew/var/homebrew/tmp/.caskroom"), "homebrew-cask-staging", "AUTO_SAFE", ["brew install", "brew update", "brew upgrade"], 86400, "remove-path", "aged Homebrew temporary cask staging")
    child_candidates(Path("/private/tmp/claude-501"), "claude-temp-session", "AUTO_SAFE", ["claude"], 86400, "remove-path", "aged inactive Claude session scratch")
    child_candidates(home / ".cache/codex-runtimes", "codex-runtime-staging", "SAFE_COSTLY", ["codex-runtime-install", "codex install"], 86400, "remove-path", "aged inactive Codex installer staging")
    output[:] = [c for c in output if not (c["category"] == "codex-runtime-staging" and Path(c["path"]).name == "codex-primary-runtime")]
    releases = home / ".dex-reach/runtime/releases"
    if releases.exists() and not releases.is_symlink():
        valid = [p for p in releases.iterdir() if p.is_dir() and not p.is_symlink() and (p / "dist").is_dir() and (p / "node_modules").is_dir()]
        active_releases = {release for release in valid if active([str(release)])}
        rollback_releases = [release for release in sorted(valid, key=lambda p: p.stat().st_mtime, reverse=True)
                             if release not in active_releases][:2]
        retained = active_releases | set(rollback_releases)
        for release in valid:
            is_active = release in active_releases
            opened = open_state(release)
            measured_size = safe_size(release)
            state = "SAFE_COSTLY" if release not in retained and not is_active and opened is False and measured_size >= 0 else "PROTECTED"
            output.append({"category":"dex-reach-release-retention", "path":str(release), "bytes":max(0, measured_size), "disposition":state, "regeneration":"rollback release", "active":is_active or opened is not False, "reason":"older validated release outside current+previous-two retention" if state == "SAFE_COSTLY" else "active, retained, open, or unmeasurable release is protected", "kind":"governor", "adapter":"remove-path"})
    build = home / "DexDictate_MacOS.nosync/.build"
    if build.exists() and not build.is_symlink():
        opened = open_state(build)
        measured_size = safe_size(build)
        state = "SAFE_COSTLY" if measured_size >= 0 and opened is False and not active(["swift build", "xcodebuild", "DexDictate"]) else "PROTECTED"
        output.append({"category":"dexdictate-build-output", "path":str(build), "bytes":max(0, measured_size), "disposition":state, "regeneration":"expensive rebuild", "active":opened is not False, "reason":"exact rebuildable DexDictate build output" if state == "SAFE_COSTLY" else "build size/live-use state is unverified", "kind":"governor", "adapter":"remove-path"})
    worktree_root = home / "Atlas_Of_One/.claude/worktrees"
    if worktree_root.exists() and not worktree_root.is_symlink():
        for worktree in sorted((p for p in worktree_root.iterdir() if p.is_dir() and not p.is_symlink()), key=lambda p: p.name):
            if _SIZE_DEADLINE is not None and time.monotonic() >= _SIZE_DEADLINE:
                output.append({"category":"claude-git-worktree", "path":str(worktree), "bytes":0, "disposition":"REPORT_ONLY", "regeneration":"Git worktree", "active":False, "reason":"watcher evidence budget exhausted before Git semantic validation", "kind":"governor", "adapter":"git-worktree-remove", "retention_seconds":86400})
                continue
            registered, clean, unique = git_worktree_state(worktree)
            opened = open_state(worktree)
            measured_size = safe_size(worktree)
            state = "SAFE_COSTLY" if measured_size >= 0 and registered and clean and not unique and opened is False and not active([str(worktree)]) and age_seconds(worktree) >= 86400 else "REPORT_ONLY"
            output.append({"category":"claude-git-worktree", "path":str(worktree), "bytes":max(0, measured_size), "disposition":state, "regeneration":"Git worktree", "active":opened is not False, "reason":"registered clean expired Git worktree" if state == "SAFE_COSTLY" else "Git semantic, size, age, or live-use validation did not prove retirement", "kind":"governor", "adapter":"git-worktree-remove", "retention_seconds":86400})
    child_candidates(home / "Library/Application Support/Google/GoogleUpdater/crx_cache", "google-updater-staging", "AUTO_SAFE", ["GoogleUpdater", "Google Update"], 86400, "remove-path", "aged inactive updater download staging")
    for root in (home / "Library/Application Support/Standard Notes/updates", home / "Library/Application Support/Standard Notes/ShipIt"):
        child_candidates(root, "standard-notes-updater-staging", "AUTO_SAFE", ["Standard Notes", "ShipIt"], 86400, "remove-path", "aged inactive ShipIt staging")
    brave = home / "Library/Caches/BraveSoftware/Brave-Browser/Default/Cache"
    if brave.exists() and not brave.is_symlink():
        opened = open_state(brave)
        measured_size = safe_size(brave)
        brave_active = active(["Brave Browser"])
        disposition = "AUTO_SAFE" if measured_size >= 0 and opened is False and not brave_active else "PROTECTED"
        output.append({"category":"brave-cache", "path":str(brave), "bytes":max(0, measured_size), "disposition":disposition, "regeneration":"automatic", "active":opened is not False or brave_active, "reason":"ordinary Brave cache" if disposition == "AUTO_SAFE" else "size/live-use/open-handle check failed", "kind":"governor", "adapter":"clear-contents"})
    clone_root = Path("/private/var/folders")
    if clone_root.exists():
        # Do not recursively find it: only report the known APFS clone pattern when supplied by bounded inventory.
        output.append({"category":"brave-code-sign-clone", "path":str(clone_root / ".../X/com.brave.Browser.code_sign_clone"), "bytes":0, "disposition":"REPORT_ONLY", "regeneration":"unknown", "active":False, "reason":"APFS clone accounting is not reclaim proof; probationary only", "kind":"governor", "adapter":"report-only"})
    for item in (home / ".gemini/antigravity", home / "Library/Containers/com.apple.mediaanalysisd", home / "Library/Mobile Documents", home / "Library/Application Support/FileProvider", home / "Library/Metadata/CoreSpotlight"):
        record = report_only(item, "apple-or-durable-managed-data", "durable, cloud, or Apple-managed state is report-only")
        if record: output.append(record)
    maccy = home / "Library/Containers/org.p0deje.Maccy"
    record = report_only(maccy, "maccy-history", "Maccy database is retained; adjust app history/image retention in Maccy preferences")
    if record: output.append(record)
    return output


def git_worktree_state(path: Path) -> tuple[bool, bool, bool]:
    """Return registered, clean/no-untracked, unique-commit-present; uncertainty is false/unsafe."""
    repo = path.parents[2]
    try:
        listed = subprocess.run(["git", "-C", str(repo), "worktree", "list", "--porcelain"], text=True, capture_output=True, timeout=8)
        if listed.returncode != 0 or f"worktree {path}" not in listed.stdout: return False, False, True
        block = next((x for x in listed.stdout.split("\n\n") if f"worktree {path}" in x), "")
        if "locked" in block: return True, False, True
        status = subprocess.run(["git", "-C", str(path), "status", "--porcelain"], text=True, capture_output=True, timeout=8)
        if status.returncode != 0 or status.stdout.strip(): return True, False, True
        branch = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], text=True, capture_output=True, timeout=8)
        others = subprocess.run(["git", "-C", str(repo), "branch", "--contains", branch.stdout.strip()], text=True, capture_output=True, timeout=8)
        unique = others.returncode != 0 or len([x for x in others.stdout.splitlines() if x.strip()]) <= 1
        return True, True, unique
    except (OSError, subprocess.TimeoutExpired):
        return False, False, True


def remove_exact(path: Path, clear_contents: bool) -> dict[str, Any]:
    if path.is_symlink(): raise RuntimeError("candidate is symlink")
    before = safe_size(path)
    if before < 0: raise RuntimeError("candidate size could not be revalidated")
    if clear_contents:
        for child in list(path.iterdir()):
            if child.is_symlink(): continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    else:
        shutil.rmtree(path) if path.is_dir() else path.unlink()
    return {"removed_bytes": before, "removed_entries": 1}


def remove_git_worktree(path: Path) -> dict[str, Any]:
    registered, clean, unique = git_worktree_state(path)
    if not registered or not clean or unique:
        raise RuntimeError("Git worktree revalidation failed")
    before = safe_size(path)
    repo = path.parents[2]
    done = subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(path)], text=True, capture_output=True, timeout=30)
    if done.returncode != 0:
        raise RuntimeError("git worktree remove failed")
    return {"removed_bytes": before, "removed_entries": 1}


def receipt(state: Path, run_id: str, candidate: dict[str, Any], before_free: int, after_free: int, action: str, validation: str, started: float, error: str | None = None) -> dict[str, Any]:
    value = {"timestamp": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "run_id": run_id, "candidate_id": candidate.get("id"), "category_id": candidate.get("category"), "path": candidate.get("path"), "classification": candidate.get("disposition"), "accounted_size_before_bytes": int(candidate.get("bytes", 0)), "apfs_immediately_free_before_bytes": before_free, "apfs_immediately_free_after_bytes": after_free, "measured_reclaim_delta_bytes": after_free - before_free, "action_taken": action, "eligibility_reason": candidate.get("reason"), "owner_live_use_result": "blocked" if candidate.get("active") else "inactive", "validation_result": validation, "duration_seconds": round(time.monotonic() - started, 3), "error_or_block_reason": error}
    append_jsonl(state / RECEIPT_FILE, value)
    return value


def recent_receipts(state: Path, limit: int = 20) -> list[dict[str, Any]]:
    return history(state / RECEIPT_FILE, limit)[-limit:]


def watcher_plist(program: str) -> str:
    log_root = Path.home() / ".local/state/dexmaint"
    return f'''<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.stinkyweasel.dexmaint.watch</string><key>ProgramArguments</key><array><string>{sys.executable}</string><string>{program}</string><string>watch</string><string>--target</string><string>macbook</string><string>--apply-auto</string></array><key>EnvironmentVariables</key><dict><key>PYTHONDONTWRITEBYTECODE</key><string>1</string></dict><key>StandardOutPath</key><string>{log_root / 'watch.stdout.log'}</string><key>StandardErrorPath</key><string>{log_root / 'watch.stderr.log'}</string><key>StartInterval</key><integer>14400</integer><key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/><key>KeepAlive</key><false/></dict></plist>'''

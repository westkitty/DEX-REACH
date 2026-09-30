#!/usr/bin/env python3
"""DEX//MAINT deterministic remote maintenance kernel.

Designed to be staged through DEX//REACH and executed on macOS. The model may
choose a supported mode; this kernel owns path policy, target verification,
manifest locking, mutation eligibility, verification receipts and the optional
Google Drive preservation path through a preconfigured rclone Drive remote.

Standard library only. rclone is optional and used only when the user explicitly
chooses Drive preservation for durable data.
"""

from __future__ import annotations

import argparse
import configparser
import dataclasses
import datetime as dt
import getpass
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import storage_governor as governor

VERSION = "2.3.1"
POLICY_VERSION = "2.3.0"
ARCHIVE_COPY_TIMEOUT_SECONDS = 300
ARCHIVE_VERIFY_TIMEOUT_SECONDS = 90
DEXCLEANER_FRESH_SECONDS = 15 * 60
BIGMAC_ACK = "BIG-MAC-EXPLICIT-CURRENT-REQUEST"
DURABLE_ACK = "DURABLE-REMOVE-EXPLICIT-CURRENT-REQUEST"

AUTO_SAFE = "AUTO_SAFE"
SAFE_COSTLY = "SAFE_COSTLY"
REPORT_ONLY = "REPORT_ONLY"
LEASED_EPHEMERAL = "LEASED_EPHEMERAL"
DURABLE_USER_DECISION = "DURABLE_USER_DECISION"
PROTECTED = "PROTECTED"

STATE_REL = Path(".local/state/dexmaint")
DRIVE_PREFIX = "GPT/Mac-Maintenance/REMOVAL-ARCHIVE"

# This is the authoritative automatic-cleanup allowlist. The Skill may explain
# these categories but may not extend them on its own.
CATEGORY_SPECS = {
    "npm-cache": {
        "relative": ".npm/_cacache",
        "disposition": AUTO_SAFE,
        "regeneration": "network-required",
        "owner_markers": ["npm ", "npx ", "pnpm ", "yarn "],
    },
    "pip-cache": {
        "relative": "Library/Caches/pip",
        "disposition": AUTO_SAFE,
        "regeneration": "network-required",
        "owner_markers": ["pip install", "python -m pip", "python3 -m pip"],
    },
    "homebrew-cache": {
        "relative": "Library/Caches/Homebrew",
        "disposition": AUTO_SAFE,
        "regeneration": "network-required",
        "owner_markers": [" brew ", "/brew "],
    },
    "playwright-browsers": {
        "relative": "Library/Caches/ms-playwright",
        "disposition": SAFE_COSTLY,
        "regeneration": "large-network-redownload",
        "owner_markers": ["playwright", "ms-playwright"],
    },
    "xcode-derived-data": {
        "relative": "Library/Developer/Xcode/DerivedData",
        "disposition": SAFE_COSTLY,
        "regeneration": "expensive-rebuild",
        "owner_markers": ["xcodebuild", "swift-build", "swift build"],
    },
    # The following categories were promoted only after evidence-backed lifecycle
    # checks established that they are rebuildable staging/cache material. Keep
    # every scope narrow: no parent-directory deletion is authorized.
    "codex-marketplace-staging": {
        "relative": ".codex/.tmp/marketplaces/.staging",
        "disposition": SAFE_COSTLY,
        "regeneration": "network-redownload",
        "owner_markers": [],
        "activity_check": "open-handles",
        "config_guard": "codex-unreferenced",
    },
    "codex-marketplace-backups": {
        "relative": ".codex/.tmp/marketplaces",
        "disposition": SAFE_COSTLY,
        "regeneration": "network-redownload",
        "owner_markers": [],
        "activity_check": "open-handles",
        "config_guard": "codex-unreferenced",
        "path_mode": "matching-children",
        "child_prefix": "marketplace-backup-",
    },
    "codex-plugin-source-staging": {
        "relative": ".codex/plugins/.marketplace-plugin-source-staging",
        "disposition": SAFE_COSTLY,
        "regeneration": "network-redownload",
        "owner_markers": [],
        "activity_check": "open-handles",
        "config_guard": "codex-unreferenced",
    },
    "codex-remote-plugin-staging": {
        "relative": ".codex/plugins/.remote-plugin-install-staging",
        "disposition": SAFE_COSTLY,
        "regeneration": "network-redownload",
        "owner_markers": [],
        "activity_check": "open-handles",
        "config_guard": "codex-unreferenced",
    },
    "codex-cache": {
        "relative": ".codex/cache",
        "disposition": AUTO_SAFE,
        "regeneration": "automatic",
        "owner_markers": [],
        "activity_check": "open-handles",
    },
    "codex-library-cache": {
        "relative": "Library/Caches/Codex",
        "disposition": AUTO_SAFE,
        "regeneration": "automatic",
        "owner_markers": [],
        "activity_check": "open-handles",
    },
    "gradle-wrapper-dists": {
        "relative": ".gradle/wrapper/dists",
        "disposition": SAFE_COSTLY,
        "regeneration": "network-redownload",
        "owner_markers": ["GradleDaemon", "gradle ", "./gradlew"],
    },
    "gradle-daemon-state": {
        "relative": ".gradle/daemon",
        "disposition": AUTO_SAFE,
        "regeneration": "automatic",
        "owner_markers": ["GradleDaemon", "gradle ", "./gradlew"],
    },
    "uv-cache": {
        "relative": ".cache/uv",
        "disposition": AUTO_SAFE,
        "regeneration": "network-required",
        "owner_markers": ["uv sync", "uv run", "uv pip", "uv tool", "uv python", "uv venv"],
    },
    "node-gyp-cache": {
        "relative": "Library/Caches/node-gyp",
        "disposition": AUTO_SAFE,
        "regeneration": "network-required",
        "owner_markers": ["node-gyp"],
    },
}

PROTECTED_HOME_NAMES = {
    ".ssh",
    ".gnupg",
    ".aws",
    ".config",
    ".local",
    "Library",
}

AGGREGATE_USER_DIRS = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"]
REVIEW_USER_DIRS = ["Downloads", "Movies", "Desktop", "Documents", "Music", "Pictures"]
DEFAULT_LARGE_FILE_MIN_BYTES = 250 * 1024**2
OPTIONAL_MAINT_MIN_BYTES = 1 * 1024**2
DEFAULT_INSTALLER_MIN_BYTES = 100 * 1024**2
DEFAULT_REVIEW_LIMIT = 40
DEFAULT_SCAN_FILE_LIMIT = 100_000
DEFAULT_SCAN_SECONDS = 12.0
INSTALLER_ARCHIVE_SUFFIXES = {
    ".dmg", ".pkg", ".zip", ".7z", ".rar", ".iso", ".img",
    ".tar", ".tgz", ".gz", ".bz2", ".xz", ".zst",
}


class DexMaintError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class Identity:
    target: str
    hostname: str
    user: str
    platform: str
    arch: str
    home: str


@dataclasses.dataclass
class Candidate:
    id: str
    category: str
    path: str
    bytes: int
    disposition: str
    regeneration: str
    active: bool
    reason: str
    kind: str = "cache"
    lease_id: str | None = None
    adapter: str | None = None
    retention_seconds: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def self_sha256() -> str:
    return sha256_file(Path(__file__).resolve())


def home_dir() -> Path:
    return Path.home()


def state_dir() -> Path:
    p = home_dir() / STATE_REL
    p.mkdir(parents=True, exist_ok=True)
    try:
        p.chmod(0o700)
    except OSError:
        pass
    for child in (p / "runs", p / "leases", p / "durable", p / "receipts"):
        child.mkdir(parents=True, exist_ok=True)
        try:
            child.chmod(0o700)
        except OSError:
            pass
    return p


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(safe_json(data) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def normalize_host(host: str) -> str:
    return host.lower().rstrip(".")


def require_bigmac_ack(target: str, ack: str | None) -> None:
    if target == "bigmac" and ack != BIGMAC_ACK:
        raise DexMaintError("BLOCKED: Big Mac requires explicit current-request acknowledgement")


def detect_identity(target: str, bigmac_ack: str | None = None, allow_non_darwin_test: bool = False) -> Identity:
    target = target.lower()
    if target not in {"macbook", "bigmac"}:
        raise DexMaintError(f"BLOCKED: unsupported target {target!r}")
    require_bigmac_ack(target, bigmac_ack)

    sysname = platform.system().lower()
    hostname = socket.gethostname()
    user = getpass.getuser()
    arch = platform.machine()
    home = str(home_dir())

    if not allow_non_darwin_test and sysname != "darwin":
        raise DexMaintError(f"BLOCKED: expected macOS target, observed {sysname}")
    if user != "andrew":
        raise DexMaintError(f"BLOCKED: expected user andrew, observed {user}")

    host = normalize_host(hostname)
    if target == "macbook":
        if "macbook-air" not in host and "macbookair" not in host:
            raise DexMaintError(f"BLOCKED: target macbook does not match hostname {hostname}")
    else:
        if "bigmac" not in host:
            raise DexMaintError(f"BLOCKED: target bigmac does not match hostname {hostname}")

    return Identity(target, hostname, user, sysname, arch, home)


def run_readonly(cmd: list[str], timeout: int = 8) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:  # pragma: no cover - defensive runtime path
        return 127, "", f"{type(e).__name__}: {e}"


def process_rows() -> list[dict[str, Any]]:
    rc, out, _ = run_readonly(["ps", "-Ao", "pid=,pcpu=,pmem=,comm=,args="], timeout=8)
    if rc != 0:
        return []
    rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[0])
            pcpu = float(parts[1])
            pmem = float(parts[2])
        except ValueError:
            continue
        rows.append({"pid": pid, "pcpu": pcpu, "pmem": pmem, "comm": parts[3], "args": parts[4]})
    return rows


def active_for_markers(markers: Iterable[str], rows: list[dict[str, Any]] | None = None) -> bool:
    rows = rows if rows is not None else process_rows()
    lowers = [m.lower() for m in markers]
    for row in rows:
        text = f" {row.get('args', '')} ".lower()
        if any(m in text for m in lowers):
            return True
    return False


def top_processes(rows: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    # Do not expose full command lines or arguments; they may contain private paths/secrets.
    ranked = sorted(rows, key=lambda x: (x.get("pcpu", 0.0), x.get("pmem", 0.0)), reverse=True)
    return [
        {"pid": r["pid"], "cpu_percent": r["pcpu"], "mem_percent": r["pmem"], "process": r["comm"]}
        for r in ranked[:limit]
    ]


def is_symlink(path: Path) -> bool:
    try:
        return stat.S_ISLNK(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def dir_size(path: Path) -> int:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return 0
    if stat.S_ISLNK(st.st_mode):
        return 0
    if stat.S_ISREG(st.st_mode):
        return st.st_size
    if not stat.S_ISDIR(st.st_mode):
        return 0

    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except (FileNotFoundError, PermissionError):
                        continue
                    mode = st.st_mode
                    if stat.S_ISLNK(mode):
                        continue
                    if stat.S_ISDIR(mode):
                        stack.append(Path(entry.path))
                    elif stat.S_ISREG(mode):
                        total += st.st_size
        except (FileNotFoundError, PermissionError, NotADirectoryError):
            continue
    return total


def ensure_exact_policy_root(path: Path, expected: Path) -> None:
    # Never follow a symlink at the policy root.
    if is_symlink(path):
        raise DexMaintError(f"BLOCKED: policy root is a symlink: {path}")
    if path.absolute() != expected.absolute():
        raise DexMaintError(f"BLOCKED: candidate path drift: {path} != {expected}")
    home = home_dir().absolute()
    try:
        path.absolute().relative_to(home)
    except ValueError:
        raise DexMaintError(f"BLOCKED: policy root escaped home: {path}")


def _last_json_line(path: Path, max_bytes: int = 131072) -> dict[str, Any] | None:
    """Read the newest valid JSONL record without loading a potentially huge history."""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in reversed([x.strip() for x in data.splitlines() if x.strip()]):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def dexcleaner_capacity_snapshot() -> dict[str, Any] | None:
    path = home_dir() / "Library/Application Support/DexCleaner/CapacityHistory/capacity-raw-v1.ndjson"
    record = _last_json_line(path)
    if not record:
        return None
    try:
        observed = parse_time(str(record["timestamp"]))
        age_seconds = max(0.0, (dt.datetime.now(dt.timezone.utc) - observed).total_seconds())
        immediate = int(record["immediatelyFreeBytes"])
        work = int(record["availableForWorkBytes"])
        purgeable = int(record["potentiallyPurgeableBytes"])
    except (KeyError, TypeError, ValueError):
        return None
    fresh = record.get("state") == "Fresh" and age_seconds <= DEXCLEANER_FRESH_SECONDS
    return {
        "source": "DexCleaner capacity history",
        "observed_at": record.get("timestamp"),
        "state": record.get("state"),
        "age_seconds": round(age_seconds, 1),
        "fresh": fresh,
        "immediately_free_bytes": immediate,
        "potentially_purgeable_bytes": purgeable,
        "available_for_work_bytes": work,
    }


def storage_snapshot() -> dict[str, Any]:
    data_path = Path("/System/Volumes/Data") if Path("/System/Volumes/Data").exists() else home_dir()
    du = shutil.disk_usage(data_path)
    pct_used = (du.used / du.total * 100.0) if du.total else 0.0
    pressure = governor.pressure_state(du.free)
    dex = dexcleaner_capacity_snapshot()
    fresh_dex = dex if dex and dex.get("fresh") else None
    return {
        "measurement_path": str(data_path),
        "capacity_bytes": du.total,
        "used_bytes": du.used,
        # Keep available_bytes as a compatibility alias for immediate APFS free.
        "available_bytes": du.free,
        "immediately_free_bytes": du.free,
        "potentially_purgeable_bytes": fresh_dex.get("potentially_purgeable_bytes") if fresh_dex else None,
        "available_for_work_bytes": fresh_dex.get("available_for_work_bytes") if fresh_dex else None,
        "preferred_goal_metric": "available-for-work" if fresh_dex else "immediately-free",
        "dexcleaner": dex,
        "used_percent": round(pct_used, 2),
        "pressure": pressure,
    }


def storage_metric_value(storage: dict[str, Any], metric: str) -> int:
    if metric == "immediately-free":
        return int(storage["immediately_free_bytes"])
    if metric == "available-for-work":
        value = storage.get("available_for_work_bytes")
        if value is None:
            raise DexMaintError("BLOCKED: available-for-work goal requires a fresh DexCleaner capacity sample")
        return int(value)
    raise DexMaintError(f"BLOCKED: unsupported storage goal metric {metric}")


def memory_snapshot() -> dict[str, Any]:
    mem_total = None
    rc, out, _ = run_readonly(["sysctl", "-n", "hw.memsize"])
    if rc == 0:
        try:
            mem_total = int(out.strip())
        except ValueError:
            pass
    rc, swap_out, _ = run_readonly(["sysctl", "vm.swapusage"])
    return {
        "physical_bytes": mem_total,
        "swap_summary": swap_out.strip() if rc == 0 else None,
        "load_average": list(os.getloadavg()),
    }


def aggregate_user_storage() -> dict[str, int]:
    home = home_dir()
    out: dict[str, int] = {}
    for name in AGGREGATE_USER_DIRS:
        p = home / name
        if p.exists() and not is_symlink(p):
            out[name] = dir_size(p)
    return out


def review_user_storage(large_file_min_bytes: int = DEFAULT_LARGE_FILE_MIN_BYTES,
                        max_candidates: int = DEFAULT_REVIEW_LIMIT,
                        file_limit: int = DEFAULT_SCAN_FILE_LIMIT,
                        seconds_limit: float = DEFAULT_SCAN_SECONDS) -> dict[str, Any]:
    """Bounded read-only reconnaissance of user-visible durable storage.

    Scan only the declared user-facing roots, never Library/config namespaces. Files
    are review candidates, never automatic cleanup candidates. Symlinks are ignored.
    """
    home = home_dir()
    start = time.monotonic()
    scanned_files = 0
    scanned_dirs = 0
    partial = False
    found: list[dict[str, Any]] = []
    now = time.time()

    def classify(path: Path, size: int, mtime: float) -> tuple[bool, str, str]:
        suffix = path.suffix.lower()
        age_days = max(0.0, (now - mtime) / 86400.0)
        is_installer = suffix in INSTALLER_ARCHIVE_SUFFIXES
        if size >= large_file_min_bytes:
            return True, "large-user-file", "large durable file"
        if is_installer and size >= DEFAULT_INSTALLER_MIN_BYTES and age_days >= 14.0:
            return True, "old-installer-archive", "older installer/archive"
        return False, "", ""

    for root_name in REVIEW_USER_DIRS:
        root = home / root_name
        if not root.exists() or is_symlink(root):
            continue
        stack = [root]
        while stack:
            if scanned_files >= file_limit or (time.monotonic() - start) >= seconds_limit:
                partial = True
                stack.clear()
                break
            current = stack.pop()
            scanned_dirs += 1
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        if scanned_files >= file_limit or (time.monotonic() - start) >= seconds_limit:
                            partial = True
                            stack.clear()
                            break
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except (FileNotFoundError, PermissionError, OSError):
                            continue
                        if stat.S_ISLNK(st.st_mode):
                            continue
                        ep = Path(entry.path)
                        if stat.S_ISDIR(st.st_mode):
                            stack.append(ep)
                            continue
                        if not stat.S_ISREG(st.st_mode):
                            continue
                        scanned_files += 1
                        include, kind, reason = classify(ep, st.st_size, st.st_mtime)
                        if not include:
                            continue
                        try:
                            display = "~/" + ep.relative_to(home).as_posix()
                        except ValueError:
                            display = ep.name
                        found.append({
                            "id": "",
                            "kind": kind,
                            "path": str(ep),
                            "display_path": display,
                            "bytes": int(st.st_size),
                            "mtime_ns": int(st.st_mtime_ns),
                            "age_days": round(max(0.0, (now - st.st_mtime) / 86400.0), 1),
                            "disposition": DURABLE_USER_DECISION,
                            "archive_eligible": True,
                            "reason": reason,
                        })
            except (FileNotFoundError, PermissionError, NotADirectoryError, OSError):
                continue
        if partial:
            break

    # Deterministic ranking: largest first, then stable display path.
    found.sort(key=lambda x: (-int(x["bytes"]), x["display_path"].lower()))
    found = found[:max_candidates]
    for idx, item in enumerate(found, start=1):
        item["id"] = f"review-{idx:03d}"
    return {
        "candidates": found,
        "scan": {
            "roots": REVIEW_USER_DIRS,
            "large_file_min_bytes": int(large_file_min_bytes),
            "old_installer_min_bytes": DEFAULT_INSTALLER_MIN_BYTES,
            "old_installer_min_age_days": 14,
            "candidate_limit": int(max_candidates),
            "file_limit": int(file_limit),
            "seconds_limit": float(seconds_limit),
            "scanned_files": scanned_files,
            "scanned_dirs": scanned_dirs,
            "partial": partial,
        },
    }


def library_hotspots(limit: int = 12, min_bytes: int = 250 * 1024**2) -> list[dict[str, Any]]:
    """Report large immediate Library namespaces without making them deletion candidates.

    Use the platform `du` with a timeout rather than unbounded Python recursion. A
    timeout simply yields no hotspot list; it never broadens cleanup authority.
    """
    root = home_dir() / "Library"
    if not root.exists() or is_symlink(root):
        return []
    rc, out, _ = run_readonly(["du", "-sk", "-d", "1", str(root)], timeout=8)
    if rc != 0:
        return []
    items: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        try:
            size = int(parts[0]) * 1024
        except ValueError:
            continue
        p = Path(parts[1])
        if p == root or p.parent != root or size < min_bytes:
            continue
        items.append({"name": p.name, "bytes": size, "disposition": REPORT_ONLY, "reason": "Library hotspot; inspect before any policy expansion"})
    items.sort(key=lambda x: (-int(x["bytes"]), x["name"].lower()))
    return items[:limit]


_OPEN_PATH_INVENTORY: tuple[bool, set[str]] | None = None


def reset_open_handle_inventory() -> None:
    global _OPEN_PATH_INVENTORY
    _OPEN_PATH_INVENTORY = None


def exact_open_handle_state(path: Path) -> bool | None:
    """Return True/False for open handles, or None when lsof cannot prove either state."""
    global _OPEN_PATH_INVENTORY
    if not path.exists():
        return False
    if shutil.which("lsof") is None:
        return None
    if _OPEN_PATH_INVENTORY is None:
        rc, out, _ = run_readonly(["lsof", "-nP", "-Fn"], timeout=20)
        if rc != 0:
            _OPEN_PATH_INVENTORY = (False, set())
        else:
            _OPEN_PATH_INVENTORY = (True, {line[1:] for line in out.splitlines() if line.startswith("n/")})
    complete, names = _OPEN_PATH_INVENTORY
    if not complete:
        return None
    target = str(path.absolute()).rstrip("/")
    return any(name == target or name.startswith(target + "/") for name in names)


def codex_config_reference_state(path: Path) -> bool | None:
    config = home_dir() / ".codex/config.toml"
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return None
    return str(path) in text


def matching_children(root: Path, prefix: str) -> list[Path]:
    if not root.exists() or is_symlink(root) or not root.is_dir():
        return []
    try:
        return sorted(
            [Path(e.path) for e in os.scandir(root) if e.name.startswith(prefix) and not e.is_symlink()],
            key=lambda p: p.name,
        )
    except OSError:
        return []


def candidate_scope_paths(spec: dict[str, Any]) -> tuple[Path, list[Path]]:
    root = home_dir() / spec["relative"]
    if spec.get("path_mode") == "matching-children":
        return root, matching_children(root, str(spec["child_prefix"]))
    return root, [root] if root.exists() else []


def category_candidates(rows: list[dict[str, Any]]) -> list[Candidate]:
    home = home_dir()
    candidates: list[Candidate] = []
    for idx, (category, spec) in enumerate(CATEGORY_SPECS.items(), start=1):
        root, scoped = candidate_scope_paths(spec)
        if not root.exists() or (spec.get("path_mode") == "matching-children" and not scoped):
            continue
        reason = "recognized exact maintenance root"
        if spec.get("path_mode") == "matching-children":
            reason = f"recognized immediate children matching {spec['child_prefix']}"
        if is_symlink(root):
            candidates.append(Candidate(
                id=f"cat-{idx:03d}", category=category, path=str(root), bytes=0,
                disposition=PROTECTED, regeneration=spec["regeneration"], active=False,
                reason="policy root is symlink; automatic mutation forbidden"
            ))
            continue

        disposition = spec["disposition"]
        active = active_for_markers(spec.get("owner_markers", []), rows) if spec.get("owner_markers") else False

        if spec.get("activity_check") == "open-handles":
            states = [exact_open_handle_state(p) for p in scoped]
            if any(state is None for state in states):
                disposition = PROTECTED
                reason = "open-handle state could not be verified; automatic mutation forbidden"
            elif any(states):
                active = True
                reason = "an exact cleanup target has an open file handle"

        if spec.get("config_guard") == "codex-unreferenced":
            refs = [codex_config_reference_state(p) for p in scoped]
            if any(state is None for state in refs):
                disposition = PROTECTED
                reason = "Codex config could not be checked; automatic mutation forbidden"
            elif any(refs):
                disposition = PROTECTED
                reason = "Codex config references this target; automatic mutation forbidden"

        candidates.append(Candidate(
            id=f"cat-{idx:03d}", category=category, path=str(root),
            bytes=sum(dir_size(p) for p in scoped), disposition=disposition,
            regeneration=spec["regeneration"], active=active, reason=reason
        ))
    for offset, record in enumerate(governor.known_hotspots(
        home, exact_open_handle_state, lambda markers: active_for_markers(markers, rows)
    ), start=len(candidates) + 1):
        candidates.append(Candidate(
            id=f"gov-{offset:03d}", category=str(record["category"]), path=str(record["path"]),
            bytes=int(record.get("bytes", 0)), disposition=str(record["disposition"]),
            regeneration=str(record.get("regeneration", "unknown")), active=bool(record.get("active")),
            reason=str(record["reason"]), kind=str(record.get("kind", "governor")),
            adapter=record.get("adapter"), retention_seconds=record.get("retention_seconds"),
        ))
    return candidates


def pid_command(pid: int) -> str | None:
    rc, out, _ = run_readonly(["ps", "-p", str(pid), "-o", "args="])
    if rc != 0:
        return None
    text = out.strip()
    return text or None


def command_hash(command: str) -> str:
    return sha256_bytes(command.encode("utf-8"))


def load_leases() -> list[dict[str, Any]]:
    d = state_dir() / "leases"
    leases = []
    for p in sorted(d.glob("*.json")):
        try:
            leases.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return leases


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def lease_candidates() -> list[Candidate]:
    now = dt.datetime.now(dt.timezone.utc)
    out: list[Candidate] = []
    for i, lease in enumerate(load_leases(), start=1):
        try:
            expires = parse_time(lease["expires_at"])
            pid = int(lease["pid"])
        except Exception:
            continue
        if expires > now:
            continue
        current = pid_command(pid)
        process_matches = bool(current and command_hash(current) == lease.get("command_sha256"))
        temp_roots = lease.get("temp_roots", [])
        bytes_total = sum(dir_size(Path(p)) for p in temp_roots if Path(p).exists())
        reason = "expired DEX lease"
        if current and not process_matches:
            reason = "expired lease but PID now belongs to a different command; process termination forbidden"
        out.append(Candidate(
            id=f"lease-{i:03d}", category="expired-dex-lease", path=";".join(temp_roots),
            bytes=bytes_total, disposition=LEASED_EPHEMERAL, regeneration="temporary",
            active=process_matches, reason=reason, kind="lease", lease_id=lease.get("lease_id")
        ))
    return out


def collect_snapshot(identity: Identity, include_recon: bool = True,
                     large_file_min_bytes: int = DEFAULT_LARGE_FILE_MIN_BYTES,
                     max_review_candidates: int = DEFAULT_REVIEW_LIMIT,
                     include_user_aggregates: bool = True) -> dict[str, Any]:
    rows = process_rows()
    candidates = [c.to_dict() for c in category_candidates(rows)]
    snap = {
        "observed_at": utc_now(),
        "identity": dataclasses.asdict(identity),
        "kernel_version": VERSION,
        "policy_version": POLICY_VERSION,
        "kernel_sha256": self_sha256(),
        "storage": storage_snapshot(),
        "memory": memory_snapshot(),
        "top_processes": top_processes(rows),
        "candidates": candidates,
        "lease_candidates": [c.to_dict() for c in lease_candidates()],
    }
    if include_user_aggregates:
        snap["protected_user_storage_aggregates"] = aggregate_user_storage()
    if include_recon:
        recon = review_user_storage(large_file_min_bytes, max_review_candidates)
        snap["review_candidates"] = recon["candidates"]
        snap["review_scan"] = recon["scan"]
        snap["library_hotspots"] = library_hotspots()
    snap["deleted_but_open"] = governor.deleted_open(run_readonly)
    return snap


def new_run_id(target: str) -> str:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    entropy = hashlib.sha256(f"{stamp}|{os.getpid()}|{time.time_ns()}".encode()).hexdigest()[:8]
    return f"maint-{target}-{stamp}-{entropy}"


def run_path(run_id: str) -> Path:
    if not re.fullmatch(r"maint-(macbook|bigmac)-[A-Za-z0-9TZ-]+-[a-f0-9]{8}", run_id):
        raise DexMaintError("BLOCKED: invalid run id")
    return state_dir() / "runs" / f"{run_id}.json"


def load_run(run_id: str) -> dict[str, Any]:
    p = run_path(run_id)
    if not p.exists():
        raise DexMaintError(f"BLOCKED: unknown run {run_id}")
    return json.loads(p.read_text(encoding="utf-8"))


def save_run(run: dict[str, Any]) -> None:
    atomic_write_json(run_path(run["run_id"]), run)


def manifest_hash(manifest: dict[str, Any]) -> str:
    body = dict(manifest)
    body.pop("manifest_sha256", None)
    return sha256_bytes(safe_json(body).encode("utf-8"))


def optional_menu_hash(menu: dict[str, Any]) -> str:
    body = dict(menu)
    body.pop("menu_sha256", None)
    return sha256_bytes(safe_json(body).encode("utf-8"))


def latest_snapshot(run: dict[str, Any]) -> dict[str, Any]:
    return run.get("after") or run["before"]


def build_optional_menu(run: dict[str, Any]) -> dict[str, Any]:
    latest = latest_snapshot(run)
    before = run["before"]
    items: list[dict[str, Any]] = []

    # Maintenance candidates: things ordinary CLEAN did not necessarily touch.
    for c in latest.get("candidates", []):
        if int(c.get("bytes", 0)) < OPTIONAL_MAINT_MIN_BYTES:
            continue
        disp = c.get("disposition")
        if disp not in {AUTO_SAFE, SAFE_COSTLY}:
            continue
        active = bool(c.get("active"))
        items.append({
            "number": 0,
            "type": "maintenance-category",
            "candidate_id": c["id"],
            "category": c["category"],
            "display": c["category"],
            "path": c["path"],
            "bytes": int(c.get("bytes", 0)),
            "disposition": disp,
            "active": active,
            "archive_eligible": False,
            "bare_number_action": "clear" if not active else "blocked-active",
            "requires_mode": "clean" if disp == AUTO_SAFE else "deep-clean",
            "reason": "recognized maintenance category" if not active else "related process appears active",
        })

    # Durable review candidates come from the original reconnaissance. Cache cleanup
    # does not change these paths; exact path/metadata is revalidated before tickets.
    for c in before.get("review_candidates", []):
        items.append({
            "number": 0,
            "type": "durable-file",
            "candidate_id": c["id"],
            "category": c["kind"],
            "display": c["display_path"],
            "path": c["path"],
            "bytes": int(c["bytes"]),
            "mtime_ns": int(c["mtime_ns"]),
            "age_days": c.get("age_days"),
            "disposition": DURABLE_USER_DECISION,
            "active": False,
            "archive_eligible": True,
            "bare_number_action": "choose-remove-or-drive",
            "reason": c["reason"],
        })

    # Show maintenance options first, then durable files largest-first.
    def key(item: dict[str, Any]) -> tuple[Any, ...]:
        lane = 0 if item["type"] == "maintenance-category" else 1
        return (lane, -int(item.get("bytes", 0)), str(item.get("display", "")).lower())
    items.sort(key=key)
    for idx, item in enumerate(items, start=1):
        item["number"] = idx

    menu = {
        "run_id": run["run_id"],
        "target": run["target"],
        "created_at": utc_now(),
        "kernel_sha256": self_sha256(),
        "policy_version": POLICY_VERSION,
        "items": items,
        "review_scan": before.get("review_scan"),
        "library_hotspots": before.get("library_hotspots", []),
        "selection_contract": {
            "maintenance_bare_numbers": "clear only the exact numbered maintenance entries after fresh revalidation",
            "durable_bare_numbers": "select only; require remove <n> or drive <n> before mutation",
            "stale_menu": "block if menu hash, kernel, policy, path metadata, or target no longer matches",
        },
    }
    menu["menu_sha256"] = optional_menu_hash(menu)
    return menu


def require_menu(run: dict[str, Any], supplied_hash: str) -> dict[str, Any]:
    menu = run.get("optional_menu")
    if not menu:
        raise DexMaintError("BLOCKED: run has no optional menu")
    expected = optional_menu_hash(menu)
    if supplied_hash != expected or menu.get("menu_sha256") != expected:
        raise DexMaintError("BLOCKED: optional menu hash mismatch")
    if menu.get("kernel_sha256") != self_sha256() or menu.get("policy_version") != POLICY_VERSION:
        raise DexMaintError("BLOCKED: optional menu is stale for this kernel/policy")
    return menu


def parse_numbers(raw: str) -> list[int]:
    nums: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token or not token.isdigit():
            raise DexMaintError("BLOCKED: selection numbers must be comma-separated positive integers")
        n = int(token)
        if n <= 0 or n in nums:
            raise DexMaintError("BLOCKED: invalid or duplicate selection number")
        nums.append(n)
    return nums


def resolve_menu_numbers(run: dict[str, Any], supplied_hash: str, raw_numbers: str) -> list[dict[str, Any]]:
    menu = require_menu(run, supplied_hash)
    wanted = parse_numbers(raw_numbers)
    by_num = {int(i["number"]): i for i in menu["items"]}
    missing = [n for n in wanted if n not in by_num]
    if missing:
        raise DexMaintError(f"BLOCKED: unknown menu numbers {missing}")
    return [by_num[n] for n in wanted]


def selected_manifest(run: dict[str, Any], menu_hash: str, raw_numbers: str) -> dict[str, Any]:
    selected = resolve_menu_numbers(run, menu_hash, raw_numbers)
    if any(i["type"] != "maintenance-category" for i in selected):
        raise DexMaintError("BLOCKED: durable menu entries require explicit remove <n> or drive <n>, not bare-number cleanup")
    current = {c.category: c.to_dict() for c in category_candidates(process_rows())}
    eligible: list[dict[str, Any]] = []
    for item in selected:
        c = current.get(item["category"])
        if not c:
            raise DexMaintError(f"BLOCKED: selected category disappeared: {item['category']}")
        if c["path"] != item["path"] or c["disposition"] not in {AUTO_SAFE, SAFE_COSTLY}:
            raise DexMaintError(f"BLOCKED: selected category changed: {item['category']}")
        if c.get("active"):
            raise DexMaintError(f"BLOCKED: selected category is active: {item['category']}")
        eligible.append(c)
    manifest = {
        "run_id": run["run_id"],
        "target": run["target"],
        "mode": "selected",
        "created_at": utc_now(),
        "policy_version": POLICY_VERSION,
        "kernel_sha256": self_sha256(),
        "menu_sha256": menu_hash,
        "selected_numbers": parse_numbers(raw_numbers),
        "target_bytes": None,
        "eligible": eligible,
        "skipped": [],
    }
    manifest["manifest_sha256"] = manifest_hash(manifest)
    return manifest


def disposition_allowed(mode: str, disposition: str) -> bool:
    if mode == "clean":
        return disposition == AUTO_SAFE
    if mode == "deep-clean":
        return disposition in {AUTO_SAFE, SAFE_COSTLY}
    if mode == "performance":
        return disposition == LEASED_EPHEMERAL
    if mode == "selected":
        return disposition in {AUTO_SAFE, SAFE_COSTLY}
    return False


def plan_from_run(run: dict[str, Any], mode: str, target_bytes: int | None = None, goal_available_bytes: int | None = None, goal_metric: str = "immediately-free") -> dict[str, Any]:
    if mode not in {"clean", "deep-clean", "performance"}:
        raise DexMaintError(f"BLOCKED: unsupported maintenance mode {mode}")
    if target_bytes is not None and goal_available_bytes is not None:
        raise DexMaintError("BLOCKED: choose either reclaim target bytes or an absolute available-space goal, not both")
    before = run["before"]
    source = before["lease_candidates"] if mode == "performance" else before["candidates"]
    eligible = []
    skipped = []
    reclaimed_budget = 0
    bytes_needed = target_bytes
    goal_current_bytes = None
    if goal_available_bytes is not None:
        goal_current_bytes = storage_metric_value(before["storage"], goal_metric)
        bytes_needed = max(0, int(goal_available_bytes) - goal_current_bytes)

    # Stable preference: safest categories first, then larger candidates.
    order = {AUTO_SAFE: 0, LEASED_EPHEMERAL: 0, SAFE_COSTLY: 1, REPORT_ONLY: 2, PROTECTED: 3}
    source = sorted(source, key=lambda c: (order.get(c["disposition"], 99), -int(c.get("bytes", 0)), c["id"]))

    for c in source:
        if not disposition_allowed(mode, c["disposition"]):
            skipped.append({**c, "skip_reason": "outside authorized mode"})
            continue
        if c.get("kind") != "lease" and c.get("active"):
            skipped.append({**c, "skip_reason": "related process appears active"})
            continue
        if c.get("kind") == "lease" and "different command" in c.get("reason", ""):
            skipped.append({**c, "skip_reason": "lease PID mismatch"})
            continue
        if bytes_needed == 0:
            break
        eligible.append(c)
        reclaimed_budget += int(c.get("bytes", 0))
        if bytes_needed is not None and reclaimed_budget >= bytes_needed:
            break

    manifest = {
        "run_id": run["run_id"],
        "target": run["target"],
        "mode": mode,
        "created_at": utc_now(),
        "policy_version": POLICY_VERSION,
        "kernel_sha256": self_sha256(),
        "target_bytes": target_bytes,
        "goal_available_bytes": goal_available_bytes,
        "goal_metric": goal_metric if goal_available_bytes is not None else None,
        "goal_current_bytes": goal_current_bytes,
        "goal_bytes_needed": bytes_needed if goal_available_bytes is not None else None,
        "goal_already_satisfied": bool(goal_available_bytes is not None and bytes_needed == 0),
        "eligible": eligible,
        "skipped": skipped,
    }
    manifest["manifest_sha256"] = manifest_hash(manifest)
    return manifest


def remove_tree_contents(root: Path) -> dict[str, Any]:
    removed_bytes = 0
    removed_entries = 0
    skipped_symlinks: list[str] = []
    if not root.exists():
        return {"removed_bytes": 0, "removed_entries": 0, "skipped_symlinks": []}
    if is_symlink(root):
        raise DexMaintError(f"BLOCKED: root is symlink: {root}")

    for entry in list(os.scandir(root)):
        p = Path(entry.path)
        try:
            st = entry.stat(follow_symlinks=False)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(st.st_mode):
            skipped_symlinks.append(str(p))
            continue
        size_before = dir_size(p)
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(p)
        elif stat.S_ISREG(st.st_mode):
            p.unlink()
        else:
            continue
        removed_bytes += size_before
        removed_entries += 1
    return {"removed_bytes": removed_bytes, "removed_entries": removed_entries, "skipped_symlinks": skipped_symlinks}


def remove_matching_children(root: Path, prefix: str) -> dict[str, Any]:
    if not root.exists():
        return {"removed_bytes": 0, "removed_entries": 0, "skipped_symlinks": []}
    if is_symlink(root):
        raise DexMaintError(f"BLOCKED: root is symlink: {root}")
    removed_bytes = 0
    removed_entries = 0
    skipped_symlinks: list[str] = []
    for p in matching_children(root, prefix):
        if is_symlink(p):
            skipped_symlinks.append(str(p))
            continue
        size_before = dir_size(p)
        if p.is_dir():
            shutil.rmtree(p)
        elif p.is_file():
            p.unlink()
        else:
            continue
        removed_bytes += size_before
        removed_entries += 1
    return {"removed_bytes": removed_bytes, "removed_entries": removed_entries, "skipped_symlinks": skipped_symlinks}


def find_lease(lease_id: str) -> dict[str, Any]:
    p = state_dir() / "leases" / f"{lease_id}.json"
    if not p.exists():
        raise DexMaintError(f"BLOCKED: missing lease {lease_id}")
    return json.loads(p.read_text(encoding="utf-8"))


def safe_tmp_root(path: Path) -> bool:
    absolute = path.absolute()
    return str(absolute).startswith("/tmp/") or str(absolute).startswith("/private/tmp/")


def reap_lease(lease_id: str) -> dict[str, Any]:
    lease = find_lease(lease_id)
    expires = parse_time(lease["expires_at"])
    if expires > dt.datetime.now(dt.timezone.utc):
        raise DexMaintError("BLOCKED: lease has not expired")
    pid = int(lease["pid"])
    current = pid_command(pid)
    process_action = "not-running"
    if current:
        if command_hash(current) != lease.get("command_sha256"):
            raise DexMaintError("BLOCKED: PID command fingerprint changed")
        os.kill(pid, signal.SIGTERM)
        process_action = "sigterm"
        deadline = time.time() + 3
        while time.time() < deadline:
            if pid_command(pid) is None:
                process_action = "terminated"
                break
            time.sleep(0.2)
        if pid_command(pid) is not None:
            process_action = "still-running-no-sigkill"
            return {"process": process_action, "temp_roots": [], "removed_bytes": 0}

    removed = 0
    cleaned: list[str] = []
    for raw in lease.get("temp_roots", []):
        p = Path(raw)
        if not safe_tmp_root(p):
            continue
        if is_symlink(p):
            continue
        if p.exists():
            size_before = dir_size(p)
            if p.is_dir():
                shutil.rmtree(p)
            elif p.is_file():
                p.unlink()
            removed += size_before
            cleaned.append(str(p))

    lease["closed_at"] = utc_now()
    lease["status"] = "reaped"
    atomic_write_json(state_dir() / "leases" / f"{lease_id}.json", lease)
    return {"process": process_action, "temp_roots": cleaned, "removed_bytes": removed}


def apply_manifest(run: dict[str, Any], supplied_hash: str, identity: Identity) -> dict[str, Any]:
    manifest = run.get("manifest")
    if not manifest:
        raise DexMaintError("BLOCKED: run has no locked manifest")
    expected_hash = manifest_hash(manifest)
    if supplied_hash != expected_hash or manifest.get("manifest_sha256") != expected_hash:
        raise DexMaintError("BLOCKED: manifest hash mismatch")
    if manifest.get("policy_version") != POLICY_VERSION:
        raise DexMaintError("BLOCKED: policy version changed after planning")
    if manifest.get("kernel_sha256") != self_sha256():
        raise DexMaintError("BLOCKED: kernel changed after planning")
    if manifest.get("target") != identity.target:
        raise DexMaintError("BLOCKED: target changed after planning")

    rows = process_rows()
    reset_open_handle_inventory()
    actions = []
    for c in manifest["eligible"]:
        goal = manifest.get("goal_available_bytes")
        if goal is not None:
            current_storage = storage_snapshot()
            if storage_metric_value(current_storage, str(manifest.get("goal_metric") or "immediately-free")) >= int(goal):
                break
        # Governor adapters are individually discovered and revalidated.  They
        # never inherit authority from a parent path or a stale inspection.
        if c.get("kind") == "governor":
            started = time.monotonic()
            before_free = int(storage_snapshot()["immediately_free_bytes"])
            current = next((x.to_dict() for x in category_candidates(rows)
                            if x.category == c.get("category") and x.path == c.get("path")), None)
            if not current or current.get("disposition") not in {AUTO_SAFE, SAFE_COSTLY} or current.get("active"):
                reason = "candidate disappeared or failed apply-time ownership/live-use revalidation"
                receipt = governor.receipt(state_dir(), run["run_id"], c, before_free, before_free,
                                           "blocked", "blocked", started, reason)
                actions.append({"candidate_id": c["id"], "category": c["category"], "status": "skipped", "reason": reason, "reclaim_receipt": receipt})
                continue
            if not disposition_allowed(manifest["mode"], str(current["disposition"])):
                reason = "authorization drift"
                receipt = governor.receipt(state_dir(), run["run_id"], c, before_free, before_free,
                                           "blocked", "blocked", started, reason)
                actions.append({"candidate_id": c["id"], "category": c["category"], "status": "skipped", "reason": reason, "reclaim_receipt": receipt})
                continue
            try:
                path = Path(str(current["path"]))
                # Every dynamic adapter is a previously enumerated exact child;
                # report-only/protected adapters cannot arrive here.
                governor.reset_size_budget(10.0)
                result = (governor.remove_git_worktree(path)
                          if current.get("adapter") == "git-worktree-remove"
                          else governor.remove_exact(path, current.get("adapter") == "clear-contents"))
                after_free = int(storage_snapshot()["immediately_free_bytes"])
                receipt = governor.receipt(state_dir(), run["run_id"], current, before_free, after_free,
                                           str(current.get("adapter")), "passed", started)
                actions.append({"candidate_id": c["id"], "category": c["category"], "status": "applied",
                                "bytes_before": int(current.get("bytes", 0)), "bytes_after": 0,
                                "measured_category_delta_bytes": int(current.get("bytes", 0)),
                                **result, "reclaim_receipt": receipt})
            except Exception as exc:
                after_free = int(storage_snapshot()["immediately_free_bytes"])
                receipt = governor.receipt(state_dir(), run["run_id"], c, before_free, after_free,
                                           "blocked", "failed", started, f"{type(exc).__name__}: {exc}")
                actions.append({"candidate_id": c["id"], "category": c["category"], "status": "skipped",
                                "reason": receipt["error_or_block_reason"], "reclaim_receipt": receipt})
            continue
        if c.get("kind") == "lease":
            result = reap_lease(c["lease_id"])
            actions.append({"candidate_id": c["id"], "category": c["category"], "status": "applied", **result})
            continue

        category = c["category"]
        spec = CATEGORY_SPECS.get(category)
        if not spec:
            actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "unknown category"})
            continue
        if not disposition_allowed(manifest["mode"], spec["disposition"]):
            actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "authorization drift"})
            continue
        if spec.get("owner_markers") and active_for_markers(spec["owner_markers"], rows):
            actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "related process became active"})
            continue
        expected = home_dir() / spec["relative"]
        p = Path(c["path"])
        ensure_exact_policy_root(p, expected)
        _, scoped = candidate_scope_paths(spec)
        if spec.get("activity_check") == "open-handles":
            states = [exact_open_handle_state(x) for x in scoped]
            if any(state is None for state in states):
                actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "open-handle state could not be reverified"})
                continue
            if any(states):
                actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "exact cleanup target became active"})
                continue
        if spec.get("config_guard") == "codex-unreferenced":
            refs = [codex_config_reference_state(x) for x in scoped]
            if any(state is None for state in refs) or any(refs):
                actions.append({"candidate_id": c["id"], "category": category, "status": "skipped", "reason": "Codex config guard failed during revalidation"})
                continue
        before_free = int(storage_snapshot()["immediately_free_bytes"])
        started = time.monotonic()
        before = sum(dir_size(x) for x in scoped)
        if spec.get("path_mode") == "matching-children":
            result = remove_matching_children(p, str(spec["child_prefix"]))
            _, scoped_after = candidate_scope_paths(spec)
            after = sum(dir_size(x) for x in scoped_after)
        else:
            result = remove_tree_contents(p)
            after = dir_size(p)
        action = {
            "candidate_id": c["id"], "category": category, "status": "applied",
            "bytes_before": before, "bytes_after": after,
            "measured_category_delta_bytes": max(0, before - after), **result,
        }
        after_free = int(storage_snapshot()["immediately_free_bytes"])
        action["reclaim_receipt"] = governor.receipt(state_dir(), run["run_id"], c, before_free, after_free,
                                                       "clear-contents", "passed", started)
        actions.append(action)

    return {"applied_at": utc_now(), "actions": actions}


def path_in_git_repo(path: Path) -> bool:
    p = path if path.is_dir() else path.parent
    for parent in [p, *p.parents]:
        if (parent / ".git").exists():
            return True
        if parent == home_dir().parent:
            break
    return False


def path_in_protected_area(path: Path) -> tuple[bool, str | None]:
    absolute = path.absolute()
    home = home_dir().absolute()
    if absolute == home or absolute == Path("/"):
        return True, "home/root cannot be durable-removal targets"
    try:
        rel = absolute.relative_to(home)
    except ValueError:
        return True, "durable removal is restricted to the user home"
    if not rel.parts:
        return True, "home cannot be removed"
    if rel.parts[0] in PROTECTED_HOME_NAMES:
        return True, f"protected home namespace: {rel.parts[0]}"
    if "DEX-REACH" in rel.parts:
        return True, "DEX//REACH infrastructure is protected"
    if path_in_git_repo(absolute):
        return True, "Git repository content is protected"
    return False, None


def tree_digest(path: Path) -> tuple[str, int, int, str]:
    """Return digest, total bytes, file count, kind. Reject symlinks anywhere."""
    if is_symlink(path):
        raise DexMaintError("BLOCKED: symlink durable target")
    if path.is_file():
        return sha256_file(path), path.stat().st_size, 1, "file"
    if not path.is_dir():
        raise DexMaintError("BLOCKED: durable target must be a regular file or directory")
    h = hashlib.sha256()
    total = 0
    count = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        root_p = Path(root)
        for name in list(dirs):
            p = root_p / name
            if is_symlink(p):
                raise DexMaintError(f"BLOCKED: symlink inside durable directory: {p}")
        for name in sorted(files):
            p = root_p / name
            if is_symlink(p):
                raise DexMaintError(f"BLOCKED: symlink inside durable directory: {p}")
            rel = p.relative_to(path).as_posix().encode("utf-8")
            size = p.stat().st_size
            digest = sha256_file(p)
            h.update(rel + b"\0" + str(size).encode() + b"\0" + digest.encode() + b"\n")
            total += size
            count += 1
    return h.hexdigest(), total, count, "directory"


def prepare_durable(path_text: str, identity: Identity) -> dict[str, Any]:
    p = Path(path_text).expanduser().absolute()
    if not p.exists():
        raise DexMaintError("BLOCKED: durable target does not exist")
    protected, reason = path_in_protected_area(p)
    if protected:
        raise DexMaintError(f"BLOCKED: {reason}")
    digest, total, count, kind = tree_digest(p)
    st = p.stat()
    ticket_id = "durable-" + hashlib.sha256(f"{p}|{st.st_mtime_ns}|{total}|{digest}|{time.time_ns()}".encode()).hexdigest()[:16]
    ticket = {
        "ticket_id": ticket_id,
        "created_at": utc_now(),
        "target": identity.target,
        "path": str(p),
        "kind": kind,
        "bytes": total,
        "file_count": count,
        "sha256": digest,
        "mtime_ns": st.st_mtime_ns,
        "archive_option": "Google Drive preservation may be selected explicitly; it is never default",
        "status": "prepared",
    }
    save_ticket(ticket)
    return ticket


def save_ticket(ticket: dict[str, Any]) -> None:
    atomic_write_json(state_dir() / "durable" / f"{ticket['ticket_id']}.json", ticket)


def load_ticket(ticket_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"durable-[a-f0-9]{16}", ticket_id):
        raise DexMaintError("BLOCKED: invalid durable ticket id")
    p = state_dir() / "durable" / f"{ticket_id}.json"
    if not p.exists():
        raise DexMaintError("BLOCKED: durable ticket not found")
    return json.loads(p.read_text(encoding="utf-8"))


def revalidate_ticket(ticket: dict[str, Any]) -> Path:
    p = Path(ticket["path"])
    if not p.exists():
        raise DexMaintError("BLOCKED: durable target disappeared")
    protected, reason = path_in_protected_area(p)
    if protected:
        raise DexMaintError(f"BLOCKED: {reason}")
    digest, total, count, kind = tree_digest(p)
    st = p.stat()
    expected = (ticket["sha256"], int(ticket["bytes"]), int(ticket["file_count"]), ticket["kind"], int(ticket["mtime_ns"]))
    observed = (digest, total, count, kind, st.st_mtime_ns)
    if observed != expected:
        raise DexMaintError("BLOCKED: durable target changed after ticket creation")
    return p


def rclone_config_path() -> Path | None:
    if shutil.which("rclone") is None:
        return None
    rc, out, _ = run_readonly(["rclone", "config", "file"], timeout=10)
    if rc != 0:
        return None
    # rclone prints e.g. "Configuration file is stored at:\n/path"
    lines = [x.strip() for x in out.splitlines() if x.strip()]
    for line in reversed(lines):
        p = Path(line).expanduser()
        if p.exists() and p.is_file():
            return p
    return None


def google_drive_rclone_remotes() -> list[str]:
    cfg = rclone_config_path()
    if cfg is None:
        return []
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(cfg, encoding="utf-8")
    except Exception:
        return []
    out = []
    for section in parser.sections():
        if parser.get(section, "type", fallback="").strip().lower() == "drive":
            out.append(section + ":")
    return sorted(out)


def rclone_drive_health() -> dict[str, Any]:
    cfg = rclone_config_path()
    remotes = google_drive_rclone_remotes()
    shared: list[str] = []
    if cfg is not None:
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read(cfg, encoding="utf-8")
            for remote in remotes:
                section = remote[:-1]
                if not parser.get(section, "client_id", fallback="").strip():
                    shared.append(remote)
        except Exception:
            pass
    rc, version_out, _ = run_readonly(["rclone", "version"], timeout=10) if shutil.which("rclone") else (127, "", "")
    version = version_out.splitlines()[0].strip() if rc == 0 and version_out.splitlines() else None
    return {
        "rclone_present": shutil.which("rclone") is not None,
        "rclone_version": version,
        "google_drive_remotes": remotes,
        "shared_client_id_remotes": shared,
        "warning": "shared rclone Google Drive client_id may be rate-limited or retired; configure a private client_id" if shared else None,
    }


def sanitize_name(name: str) -> str:
    name = re.sub(r"[\\/:\x00-\x1f]+", "_", name).strip()
    return name[:180] or "artifact"


def archive_destination(ticket: dict[str, Any]) -> str:
    existing = ticket.get("archive_destination")
    if existing:
        return str(existing)
    p = Path(ticket["path"])
    date = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    base = sanitize_name(p.name)
    suffix = ticket["sha256"][:8]
    if ticket["kind"] == "directory":
        leaf = f"{base}__{suffix}"
    else:
        stem = sanitize_name(p.stem)
        ext = p.suffix
        leaf = f"{stem}__{suffix}{ext}"
    return f"{DRIVE_PREFIX}/{date}/{leaf}"


def remote_md5_probe(dest: str, expected_md5: str, timeout: int = 30) -> dict[str, Any]:
    rc, out, err = run_readonly(["rclone", "md5sum", dest], timeout=timeout)
    hashes: list[str] = []
    for line in out.splitlines():
        m = re.match(r"^([a-fA-F0-9]{32})\s+", line.strip())
        if m:
            hashes.append(m.group(1).lower())
    if hashes:
        matches = all(h == expected_md5.lower() for h in hashes)
        return {"state": "matching" if matches else "mismatch", "hashes": hashes, "count": len(hashes), "stderr": err.strip()}
    message = (err + "\n" + out).lower()
    absent_markers = ["not found", "directory not found", "object not found"]
    if rc != 0 and any(marker in message for marker in absent_markers):
        return {"state": "absent", "hashes": [], "count": 0, "stderr": err.strip()}
    return {"state": "unverified", "hashes": [], "count": 0, "stderr": err.strip() or out.strip()}


def record_verified_archive(ticket: dict[str, Any], remote: str, dest_rel: str, verify_method: str, remote_match_count: int = 1) -> dict[str, Any]:
    receipt = {
        "provider": "google-drive",
        "transport": "rclone",
        "remote": remote,
        "destination": dest_rel,
        "verified": True,
        "verified_at": utc_now(),
        "source_sha256": ticket["sha256"],
        "source_bytes": ticket["bytes"],
        "verification": verify_method,
        "remote_match_count": remote_match_count,
        "warning": "multiple matching Drive objects exist at the exact destination; no additional upload was created" if remote_match_count > 1 else None,
    }
    ticket["archive_receipt"] = receipt
    ticket["status"] = "archived-verified"
    ticket.pop("archive_last_error", None)
    save_ticket(ticket)
    return receipt


def archive_to_rclone(ticket: dict[str, Any], remote: str, copy_timeout: int = ARCHIVE_COPY_TIMEOUT_SECONDS) -> dict[str, Any]:
    p = revalidate_ticket(ticket)
    allowed = google_drive_rclone_remotes()
    if remote not in allowed:
        raise DexMaintError("BLOCKED: selected rclone remote is not configured as Google Drive")
    copy_timeout = max(30, min(int(copy_timeout), 900))
    dest_rel = archive_destination(ticket)
    ticket["archive_destination"] = dest_rel
    dest = remote + dest_rel

    if ticket["kind"] == "file":
        local_md5 = md5_file(p)
        ticket["status"] = "remote-check"
        save_ticket(ticket)
        probe = remote_md5_probe(dest, local_md5)
        if probe["state"] == "matching":
            return record_verified_archive(ticket, remote, dest_rel, "existing remote MD5 match", int(probe["count"]))
        if probe["state"] == "mismatch":
            ticket["status"] = "remote-present-unverified"
            ticket["archive_last_error"] = "existing destination has a different MD5"
            save_ticket(ticket)
            raise DexMaintError("ARCHIVE BLOCKED: exact Drive destination exists with a different MD5")
        if probe["state"] == "unverified":
            ticket["status"] = "remote-present-unverified"
            ticket["archive_last_error"] = probe.get("stderr") or "remote state could not be established"
            save_ticket(ticket)
            raise DexMaintError("ARCHIVE UNVERIFIED: exact remote destination could not be checked safely")

        attempts = list(ticket.get("archive_attempts", []))
        attempts.append({"started_at": utc_now(), "destination": dest_rel, "copy_timeout_seconds": copy_timeout})
        ticket["archive_attempts"] = attempts[-10:]
        ticket["status"] = "uploading"
        save_ticket(ticket)
        rc, out, err = run_readonly(["rclone", "copyto", str(p), dest, "--immutable"], timeout=copy_timeout)

        # Regardless of command result, reconcile the remote state before deciding.
        post = remote_md5_probe(dest, local_md5, timeout=ARCHIVE_VERIFY_TIMEOUT_SECONDS)
        if post["state"] == "matching":
            method = "rclone copyto + remote MD5 match" if rc == 0 else "post-timeout remote MD5 match"
            return record_verified_archive(ticket, remote, dest_rel, method, int(post["count"]))
        if post["state"] == "mismatch":
            ticket["status"] = "remote-present-unverified"
            ticket["archive_last_error"] = "remote MD5 mismatch after copy attempt"
            save_ticket(ticket)
            raise DexMaintError("ARCHIVE UNVERIFIED: Google Drive MD5 mismatch")
        ticket["status"] = "prepared"
        ticket["archive_last_error"] = err.strip() or out.strip() or "copy failed and no verified remote object exists"
        save_ticket(ticket)
        raise DexMaintError(f"ARCHIVE FAILED: local original kept; {ticket['archive_last_error']}")

    ticket["status"] = "uploading"
    save_ticket(ticket)
    rc, out, err = run_readonly(["rclone", "copy", str(p), dest, "--immutable"], timeout=copy_timeout)
    if rc != 0:
        ticket["status"] = "prepared"
        ticket["archive_last_error"] = err.strip() or out.strip()
        save_ticket(ticket)
        raise DexMaintError(f"ARCHIVE FAILED: rclone copy: {ticket['archive_last_error']}")
    rc, checkout, checkerr = run_readonly(["rclone", "check", str(p), dest, "--one-way"], timeout=ARCHIVE_VERIFY_TIMEOUT_SECONDS)
    if rc != 0:
        ticket["status"] = "remote-present-unverified"
        ticket["archive_last_error"] = checkerr.strip() or checkout.strip()
        save_ticket(ticket)
        raise DexMaintError(f"ARCHIVE UNVERIFIED: rclone check failed: {ticket['archive_last_error']}")
    return record_verified_archive(ticket, remote, dest_rel, "rclone copy + rclone check")


def remove_durable(ticket: dict[str, Any], ack: str | None, require_archive: bool) -> dict[str, Any]:
    if ack != DURABLE_ACK:
        raise DexMaintError("BLOCKED: durable removal requires explicit current-request acknowledgement")
    p = revalidate_ticket(ticket)
    if require_archive:
        receipt = ticket.get("archive_receipt")
        if not receipt or receipt.get("provider") != "google-drive" or receipt.get("verified") is not True:
            raise DexMaintError("BLOCKED: Google Drive archive was requested but no verified receipt exists")
        if receipt.get("source_sha256") != ticket["sha256"] or int(receipt.get("source_bytes", -1)) != int(ticket["bytes"]):
            raise DexMaintError("BLOCKED: archive receipt does not match current durable ticket")

    before = int(ticket["bytes"])
    if ticket["kind"] == "file":
        p.unlink()
    elif ticket["kind"] == "directory":
        shutil.rmtree(p)
    else:  # pragma: no cover
        raise DexMaintError("BLOCKED: unsupported durable kind")

    ticket["removed_at"] = utc_now()
    ticket["status"] = "removed-after-archive" if require_archive else "removed-explicitly-without-archive"
    atomic_write_json(state_dir() / "durable" / f"{ticket['ticket_id']}.json", ticket)
    append_jsonl(state_dir() / "ledger.jsonl", {
        "event": "durable-remove", "at": utc_now(), "ticket_id": ticket["ticket_id"],
        "target": ticket["target"], "bytes": before, "archive_used": require_archive,
        "archive_receipt": ticket.get("archive_receipt") if require_archive else None,
    })
    return {"removed": True, "bytes": before, "archive_used": require_archive, "path": ticket["path"]}


def register_lease(pid: int, purpose: str, project: str | None, ttl_seconds: int, temp_roots: list[str]) -> dict[str, Any]:
    if ttl_seconds < 60 or ttl_seconds > 7 * 24 * 3600:
        raise DexMaintError("BLOCKED: lease ttl must be between 60 seconds and 7 days")
    command = pid_command(pid)
    if not command:
        raise DexMaintError("BLOCKED: process not found")
    clean_roots = []
    for raw in temp_roots:
        p = Path(raw).absolute()
        if not safe_tmp_root(p):
            raise DexMaintError(f"BLOCKED: lease temp root must live under /tmp or /private/tmp: {p}")
        clean_roots.append(str(p))
    lease_id = "lease-" + hashlib.sha256(f"{pid}|{command}|{time.time_ns()}".encode()).hexdigest()[:16]
    now = dt.datetime.now(dt.timezone.utc)
    lease = {
        "lease_id": lease_id,
        "pid": pid,
        "command_sha256": command_hash(command),
        "purpose": purpose,
        "project": project,
        "created_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "expires_at": (now + dt.timedelta(seconds=ttl_seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "temp_roots": clean_roots,
        "status": "active",
    }
    atomic_write_json(state_dir() / "leases" / f"{lease_id}.json", lease)
    return lease


def print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, sort_keys=True))


def status_payload(identity: Identity) -> dict[str, Any]:
    """Return a small stable status contract for local UI clients.

    This deliberately avoids candidate discovery and mutation. It reports current
    APFS capacity plus the most recent persisted watcher evidence.
    """
    state = state_dir()
    storage = storage_snapshot()
    lock = state / governor.LOCK_FILE
    watcher_running = False
    watcher_pid: int | None = None
    if lock.exists():
        try:
            candidate_pid = int(lock.read_text(encoding="utf-8").strip())
            command = pid_command(candidate_pid)
            if command and "dexmaint_remote.py watch" in command:
                watcher_running = True
                watcher_pid = candidate_pid
        except (OSError, ValueError):
            pass

    latest_run: dict[str, Any] | None = None
    run_files = sorted(
        (state / "runs").glob(f"maint-{identity.target}-*.json"),
        key=lambda path: path.name,
        reverse=True,
    )
    for path in run_files:
        try:
            candidate = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if candidate.get("target") != identity.target:
            continue
        latest_run = candidate
        break

    last_run_summary: dict[str, Any] | None = None
    if latest_run is not None:
        run_id = str(latest_run.get("run_id", ""))
        receipts = [
            row for row in governor.history(state / governor.RECEIPT_FILE)
            if row.get("run_id") == run_id
        ]
        before = latest_run.get("before") if isinstance(latest_run.get("before"), dict) else {}
        before_storage = before.get("storage") if isinstance(before.get("storage"), dict) else {}
        deleted_open = before.get("deleted_but_open") if isinstance(before.get("deleted_but_open"), dict) else {}
        candidates = before.get("candidates") if isinstance(before.get("candidates"), list) else []
        protected_count = sum(
            1 for item in candidates
            if isinstance(item, dict) and item.get("disposition") in {PROTECTED, REPORT_ONLY, DURABLE_USER_DECISION}
        )
        last_run_summary = {
            "run_id": run_id,
            "created_at": latest_run.get("created_at"),
            "status": latest_run.get("status"),
            "pressure": before_storage.get("pressure"),
            "action_count": len(receipts),
            "accounted_candidate_bytes": sum(int(row.get("accounted_size_before_bytes", 0)) for row in receipts),
            "measured_reclaim_bytes": sum(int(row.get("measured_reclaim_delta_bytes", 0)) for row in receipts),
            "deleted_open_bytes": deleted_open.get("pinned_bytes"),
            "reboot_recommended": bool(deleted_open.get("reboot_recommended", False)),
            "protected_or_blocked_count": protected_count,
        }

    return {
        "schema_version": 1,
        "status": "ok",
        "observed_at": utc_now(),
        "kernel_version": VERSION,
        "policy_version": POLICY_VERSION,
        "target": identity.target,
        "immediately_free_bytes": int(storage["immediately_free_bytes"]),
        "available_for_work_bytes": storage.get("available_for_work_bytes"),
        "pressure": storage["pressure"],
        "target_free_bytes": 30 * 1024**3,
        "watcher_running": watcher_running,
        "watcher_pid": watcher_pid,
        "last_run": last_run_summary,
    }


def cmd_status(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    print_json(status_payload(identity))


def cmd_capabilities(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    print_json({
        "status": "ok",
        "identity": dataclasses.asdict(identity),
        "kernel_version": VERSION,
        "policy_version": POLICY_VERSION,
        "kernel_sha256": self_sha256(),
        "modes": ["inspect", "clean", "deep-clean", "performance", "goal-bounded clean/deep-clean", "numbered optional menu", "selected maintenance cleanup"],
        "storage_recon": {
            "review_roots": REVIEW_USER_DIRS,
            "default_large_file_min_bytes": DEFAULT_LARGE_FILE_MIN_BYTES,
            "old_installer_min_bytes": DEFAULT_INSTALLER_MIN_BYTES,
            "durable_files_are_never_bare-number-deleted": True,
        },
        "drive_preservation": {
            "default": False,
            "rclone_google_drive_remotes": google_drive_rclone_remotes(),
            "fixed_archive_prefix": DRIVE_PREFIX,
            "copy_timeout_seconds": ARCHIVE_COPY_TIMEOUT_SECONDS,
            "health": rclone_drive_health(),
        },
        "automatic_categories": {k: {"disposition": v["disposition"], "relative": v["relative"]} for k, v in CATEGORY_SPECS.items()},
    })


def cmd_inspect(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    run_id = new_run_id(identity.target)
    before = collect_snapshot(identity, include_recon=True,
                              large_file_min_bytes=args.large_file_min_bytes,
                              max_review_candidates=args.max_review_candidates)
    before["storage_governance"] = governor.record_observations(
        state_dir(), run_id, before["candidates"], int(before["storage"]["immediately_free_bytes"])
    )
    run = {
        "run_id": run_id,
        "target": identity.target,
        "created_at": utc_now(),
        "status": "INSPECTED",
        "before": before,
    }
    save_run(run)
    print_json(run)


def cmd_menu(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    if run["before"]["identity"]["hostname"] != identity.hostname:
        raise DexMaintError("BLOCKED: execution identity changed since inspection")
    menu = build_optional_menu(run)
    run["optional_menu"] = menu
    save_run(run)
    print_json(menu)


def cmd_resolve_menu(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    if run["before"]["identity"]["hostname"] != identity.hostname:
        raise DexMaintError("BLOCKED: execution identity changed since inspection")
    selected = resolve_menu_numbers(run, args.menu_sha256, args.numbers)
    print_json({"run_id": run["run_id"], "menu_sha256": args.menu_sha256, "selected": selected})


def cmd_plan_selected(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    if run["before"]["identity"]["hostname"] != identity.hostname:
        raise DexMaintError("BLOCKED: execution identity changed since inspection")
    # A selected cleanup is its own measurement window even when it follows a
    # previously closed CLEAN transaction on the same menu-producing run.
    run["selection_before"] = collect_snapshot(identity, include_recon=False)
    manifest = selected_manifest(run, args.menu_sha256, args.numbers)
    run["manifest"] = manifest
    run["status"] = "MANIFEST_LOCKED"
    save_run(run)
    print_json(manifest)


def cmd_prepare_selected_durable(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    selected = resolve_menu_numbers(run, args.menu_sha256, str(args.number))
    item = selected[0]
    if item["type"] != "durable-file":
        raise DexMaintError("BLOCKED: selected number is not a durable-file candidate")
    p = Path(item["path"])
    if not p.exists() or is_symlink(p) or not p.is_file():
        raise DexMaintError("BLOCKED: durable menu candidate changed or disappeared")
    st = p.stat()
    if int(st.st_size) != int(item["bytes"]) or int(st.st_mtime_ns) != int(item["mtime_ns"]):
        raise DexMaintError("BLOCKED: durable menu candidate metadata changed; regenerate menu")
    ticket = prepare_durable(str(p), identity)
    ticket["menu_origin"] = {
        "run_id": run["run_id"],
        "menu_sha256": args.menu_sha256,
        "number": int(args.number),
        "candidate_id": item.get("candidate_id"),
        "display": item.get("display"),
    }
    save_ticket(ticket)
    print_json(ticket)


def cmd_plan(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    if run["before"]["identity"]["hostname"] != identity.hostname:
        raise DexMaintError("BLOCKED: execution identity changed since inspection")
    manifest = plan_from_run(run, args.mode, args.target_bytes, args.goal_available_bytes, args.goal_metric)
    run["manifest"] = manifest
    run["status"] = "MANIFEST_LOCKED"
    save_run(run)
    print_json(manifest)


def cmd_apply(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    result = apply_manifest(run, args.manifest_sha256, identity)
    run["apply"] = result
    run["status"] = "APPLIED"
    save_run(run)
    print_json(result)


def cmd_verify(args: argparse.Namespace) -> None:
    run = load_run(args.run)
    identity = detect_identity(run["target"], args.bigmac_ack)
    after = collect_snapshot(identity, include_recon=False)
    after["storage_governance"] = governor.record_observations(
        state_dir(), run["run_id"], after["candidates"], int(after["storage"]["immediately_free_bytes"])
    )
    baseline = run.get("selection_before") if run.get("manifest", {}).get("mode") == "selected" else run["before"]
    before_avail = int(baseline["storage"]["immediately_free_bytes"])
    after_avail = int(after["storage"]["immediately_free_bytes"])
    before_work = baseline["storage"].get("available_for_work_bytes")
    after_work = after["storage"].get("available_for_work_bytes")
    actions = run.get("apply", {}).get("actions", [])
    category_delta = sum(int(a.get("measured_category_delta_bytes", a.get("removed_bytes", 0)) or 0) for a in actions)
    result = {
        "verified_at": utc_now(),
        "run_id": run["run_id"],
        "target": run["target"],
        "before_available_bytes": before_avail,
        "after_available_bytes": after_avail,
        "before_immediately_free_bytes": before_avail,
        "after_immediately_free_bytes": after_avail,
        "volume_available_delta_bytes": after_avail - before_avail,
        "before_available_for_work_bytes": before_work,
        "after_available_for_work_bytes": after_work,
        "available_for_work_delta_bytes": (int(after_work) - int(before_work)) if before_work is not None and after_work is not None else None,
        "measured_category_delta_bytes": category_delta,
        "storage_pressure_after": after["storage"]["pressure"],
        "status": "CLEAN" if run.get("apply") else "INSPECTION_ONLY",
    }
    run["after"] = after
    run["verification"] = result
    run["status"] = "CLOSED"
    save_run(run)
    append_jsonl(state_dir() / "ledger.jsonl", {
        "event": "maintenance-run", "at": utc_now(), "run_id": run["run_id"],
        "target": run["target"], "mode": run.get("manifest", {}).get("mode"),
        "before_available_bytes": before_avail, "after_available_bytes": after_avail,
        "volume_available_delta_bytes": after_avail - before_avail,
        "measured_category_delta_bytes": category_delta,
        "status": result["status"],
    })
    print_json(result)


def cmd_watch(args: argparse.Namespace) -> None:
    """Bounded hotspot watcher; an exclusive lock prevents overlapping launchd runs."""
    identity = detect_identity(args.target, args.bigmac_ack)
    lock = state_dir() / governor.LOCK_FILE
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        try:
            lock_pid = int(lock.read_text(encoding="utf-8").strip())
            lock_command = pid_command(lock_pid)
        except (OSError, ValueError):
            lock_command = None
        if lock_command and "dexmaint_remote.py watch" in lock_command:
            print_json({"status": "BLOCKED", "reason": "storage watcher already running"})
            return
        try:
            lock.unlink()
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except OSError:
            print_json({"status": "BLOCKED", "reason": "stale watcher lock could not be reconciled"})
            return
    try:
        os.write(fd, str(os.getpid()).encode("ascii"))
        run_id = new_run_id(identity.target)
        before = collect_snapshot(identity, include_recon=False, include_user_aggregates=False)
        before["storage_governance"] = governor.record_observations(
            state_dir(), run_id, before["candidates"], int(before["storage"]["immediately_free_bytes"])
        )
        run = {"run_id": run_id, "target": identity.target, "created_at": utc_now(), "status": "WATCHED", "before": before}
        pressure = before["storage"]["pressure"]
        if args.apply_auto and pressure in {"LOW", "CRITICAL", "EMERGENCY"}:
            # LOW is AUTO_SAFE only; SAFE_COSTLY begins only under CRITICAL.
            mode = "clean" if pressure == "LOW" else "deep-clean"
            run["manifest"] = plan_from_run(run, mode, goal_available_bytes=30 * 1024**3, goal_metric="immediately-free")
            run["status"] = "MANIFEST_LOCKED"
            save_run(run)
            run["apply"] = apply_manifest(run, run["manifest"]["manifest_sha256"], identity)
            run["status"] = "APPLIED"
        save_run(run)
        print_json({"status": run["status"], "run_id": run_id, "pressure": pressure,
                    "reclaim_receipts": governor.recent_receipts(state_dir()),
                    "deleted_but_open": before["deleted_but_open"]})
    finally:
        try: os.close(fd)
        except OSError: pass
        try: lock.unlink()
        except OSError: pass


def cmd_watcher_plist(args: argparse.Namespace) -> None:
    print(governor.watcher_plist(str(Path(__file__).resolve())))


def cmd_lease_register(args: argparse.Namespace) -> None:
    detect_identity(args.target, args.bigmac_ack)
    print_json(register_lease(args.pid, args.purpose, args.project, args.ttl_seconds, args.temp_root or []))


def cmd_prepare_durable(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    print_json(prepare_durable(args.path, identity))


def cmd_drive_remotes(args: argparse.Namespace) -> None:
    detect_identity(args.target, args.bigmac_ack)
    print_json({"google_drive_rclone_remotes": google_drive_rclone_remotes(), "health": rclone_drive_health()})


def cmd_archive_drive(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    ticket = load_ticket(args.ticket)
    if ticket["target"] != identity.target:
        raise DexMaintError("BLOCKED: durable ticket belongs to another target")
    print_json(archive_to_rclone(ticket, args.remote, args.copy_timeout_seconds))


def cmd_remove_durable(args: argparse.Namespace) -> None:
    identity = detect_identity(args.target, args.bigmac_ack)
    ticket = load_ticket(args.ticket)
    if ticket["target"] != identity.target:
        raise DexMaintError("BLOCKED: durable ticket belongs to another target")
    # Reload after optional archive operation so the verified receipt is current.
    ticket = load_ticket(args.ticket)
    print_json(remove_durable(ticket, args.durable_ack, args.require_archive))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dexmaint_remote.py")
    p.add_argument("--version", action="version", version=VERSION)
    sub = p.add_subparsers(dest="command", required=True)

    def add_target(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--target", required=True, choices=["macbook", "bigmac"])
        sp.add_argument("--bigmac-ack")

    s = sub.add_parser("capabilities")
    add_target(s); s.set_defaults(func=cmd_capabilities)

    s = sub.add_parser("status")
    add_target(s); s.set_defaults(func=cmd_status)

    s = sub.add_parser("inspect")
    add_target(s)
    s.add_argument("--large-file-min-bytes", type=int, default=DEFAULT_LARGE_FILE_MIN_BYTES)
    s.add_argument("--max-review-candidates", type=int, default=DEFAULT_REVIEW_LIMIT)
    s.set_defaults(func=cmd_inspect)

    s = sub.add_parser("menu")
    s.add_argument("--run", required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_menu)

    s = sub.add_parser("resolve-menu")
    s.add_argument("--run", required=True)
    s.add_argument("--menu-sha256", required=True)
    s.add_argument("--numbers", required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_resolve_menu)

    s = sub.add_parser("plan-selected")
    s.add_argument("--run", required=True)
    s.add_argument("--menu-sha256", required=True)
    s.add_argument("--numbers", required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_plan_selected)

    s = sub.add_parser("prepare-selected-durable")
    s.add_argument("--run", required=True)
    s.add_argument("--menu-sha256", required=True)
    s.add_argument("--number", type=int, required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_prepare_selected_durable)

    s = sub.add_parser("plan")
    s.add_argument("--run", required=True)
    s.add_argument("--mode", required=True, choices=["clean", "deep-clean", "performance"])
    s.add_argument("--target-bytes", type=int, help="amount to reclaim, not an absolute free-space target")
    s.add_argument("--goal-available-bytes", type=int, help="absolute free/available-for-work goal")
    s.add_argument("--goal-metric", choices=["immediately-free", "available-for-work"], default="immediately-free")
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_plan)

    s = sub.add_parser("apply")
    s.add_argument("--run", required=True)
    s.add_argument("--manifest-sha256", required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_apply)

    s = sub.add_parser("verify")
    s.add_argument("--run", required=True)
    s.add_argument("--bigmac-ack")
    s.set_defaults(func=cmd_verify)

    s = sub.add_parser("watch")
    add_target(s)
    s.add_argument("--apply-auto", action="store_true", help="apply only pressure-authorized manifest-locked cleanup")
    s.set_defaults(func=cmd_watch)

    s = sub.add_parser("watcher-plist")
    s.set_defaults(func=cmd_watcher_plist)

    s = sub.add_parser("lease-register")
    add_target(s)
    s.add_argument("--pid", type=int, required=True)
    s.add_argument("--purpose", required=True)
    s.add_argument("--project")
    s.add_argument("--ttl-seconds", type=int, default=7200)
    s.add_argument("--temp-root", action="append")
    s.set_defaults(func=cmd_lease_register)

    s = sub.add_parser("prepare-durable")
    add_target(s)
    s.add_argument("--path", required=True)
    s.set_defaults(func=cmd_prepare_durable)

    s = sub.add_parser("drive-remotes")
    add_target(s); s.set_defaults(func=cmd_drive_remotes)

    s = sub.add_parser("archive-drive")
    add_target(s)
    s.add_argument("--ticket", required=True)
    s.add_argument("--remote", required=True)
    s.add_argument("--copy-timeout-seconds", type=int, default=ARCHIVE_COPY_TIMEOUT_SECONDS)
    s.set_defaults(func=cmd_archive_drive)

    s = sub.add_parser("remove-durable")
    add_target(s)
    s.add_argument("--ticket", required=True)
    s.add_argument("--durable-ack", required=True)
    s.add_argument("--require-archive", action="store_true")
    s.set_defaults(func=cmd_remove_durable)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
        return 0
    except DexMaintError as e:
        print_json({"status": "BLOCKED", "error": str(e), "kernel_version": VERSION, "policy_version": POLICY_VERSION})
        return 2
    except Exception as e:  # defensive: never auto-escalate on unexpected behavior
        print_json({"status": "ERROR", "error": f"{type(e).__name__}: {e}", "kernel_version": VERSION})
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Refuse model, tarball, and container-image pulls unless `/` has 10 GB free.

This gate exists because qwen3-vl:2b-instruct plus a current Ollama runtime
needs roughly 6–8 GB, and a pull that proceeds under that margin fills the
root filesystem. Optional leftover `/tmp/podman-storage` is on tmpfs and
cannot satisfy this budget even if it is deleted.

Exit 0 when the pull is allowed. Exit 2 when it must be skipped.
Never deletes ~/Documents or ~/go.
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

MINIMUM_FREE_GB = 10
ABORT_REMAINING_FREE_GB = 2
PODMAN_LEFTOVER = Path("/tmp/podman-storage")


def available_gb(mount: str = "/") -> int:
    usage = shutil.disk_usage(mount)
    return usage.free // (1024**3)


def maybe_reclaim_podman_leftover() -> str:
    if not PODMAN_LEFTOVER.exists():
        return "absent"
    try:
        shutil.rmtree(PODMAN_LEFTOVER)
        return "removed"
    except OSError as exc:
        return f"skipped:{type(exc).__name__}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reclaim-tmp-podman",
        action="store_true",
        help="Attempt to delete leftover /tmp/podman-storage only (tmpfs; optional)",
    )
    parser.add_argument(
        "--abort-below-gb",
        type=int,
        default=ABORT_REMAINING_FREE_GB,
        help="During an in-progress pull, abort if remaining free space drops below this",
    )
    args = parser.parse_args()
    if args.reclaim_tmp_podman:
        print(f"podman_leftover={maybe_reclaim_podman_leftover()}")
    free_gb = available_gb("/")
    print(f"disk_free_gb={free_gb} minimum_gb={MINIMUM_FREE_GB} mount=/")
    if free_gb < MINIMUM_FREE_GB:
        print("disk_gate=skip_pull reason=insufficient_free_space")
        return 2
    print(
        "disk_gate=allow_pull "
        f"abort_if_remaining_below_gb={args.abort_below_gb}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Generate checked-in TypeScript and Python policy modules from the shared registry."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from app.policy_compiler import PolicyCompilerError, assert_generated_current, write_generated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if generated modules drift from detector-registry.json",
    )
    args = parser.parse_args()
    try:
        digest = assert_generated_current(ROOT) if args.check else write_generated(ROOT)
    except PolicyCompilerError as exc:
        print(f"policy_compiler=failed detail={exc}")
        return 1
    mode = "checked" if args.check else "wrote"
    print(f"policy_compiler={mode} digest={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

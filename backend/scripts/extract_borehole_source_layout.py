"""CLI for the preservation-first borehole PDF extraction PoC."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.borehole_source_layout import build_preservation_poc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--pages",
        help="One-based page list, for example 1,2,5. Omit to process all pages.",
    )
    args = parser.parse_args()

    pages = [int(value) for value in args.pages.split(",")] if args.pages else None
    result = build_preservation_poc(args.pdf, pages=pages)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    observations = result["observations"]["groundwater_depth"]
    print(f"layout pages: {len(result['layout']['pages'])}")
    print(f"groundwater observations: {len(observations)}")
    print(f"output: {args.output.resolve()}")


if __name__ == "__main__":
    main()

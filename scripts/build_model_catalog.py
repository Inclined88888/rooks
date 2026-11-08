"""Builds the bundled model catalog snapshot (workbench/backend/app/data/models_catalog.json) from models.dev's api.json.

    ~/.venvs/aiw/bin/python scripts/build_model_catalog.py path/to/api.json     # or no argument to download it

A build tool, not part of the running app (it used to be app/catalog_build.py). The runtime keeps the same trimmed
shape when it refreshes (catalog.refresh), so the two never drift.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench" / "backend"))

from app import catalog  # noqa: E402  (catalog.py imports nothing else from the app, so no settings are read)


def main(argv: list[str]) -> int:
    raw = json.loads(Path(argv[1]).read_text()) if len(argv) > 1 else catalog.download()
    out = catalog.trim(raw)
    catalog.SNAPSHOT.write_text(json.dumps(out, separators=(",", ":"), sort_keys=True))
    print(f"{sum(len(v) for v in out['providers'].values())} models from {len(out['providers'])} providers -> {catalog.SNAPSHOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

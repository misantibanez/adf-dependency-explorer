"""Copy the canonical graph engines into the deployable Apps source directory."""

import shutil
from pathlib import Path


def prepare(root: Path | None = None) -> Path:
    root = root or Path(__file__).resolve().parent.parent
    target = root / "databricks" / "app"
    for name in ("graph.js", "history.js"):
        shutil.copyfile(root / name, target / "static" / name)
    return target


if __name__ == "__main__":
    print(prepare())

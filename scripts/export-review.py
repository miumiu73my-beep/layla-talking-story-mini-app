#!/usr/bin/env python3
"""Export Git-tracked text sources as one reviewer-friendly UTF-8 document.

The public/app.json Mini-App metadata and app icon/image files are intentionally
omitted at the user's request. The document is generated, not committed.
"""
from datetime import datetime, timezone
from pathlib import Path
import subprocess

ALLOWED_SUFFIXES = {".js", ".mjs", ".ts", ".tsx", ".py", ".css", ".html",
                    ".json", ".yaml", ".yml", ".md", ".txt"}
EXCLUDE = {"app.json", "package-lock.json"}
SOURCE_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = SOURCE_ROOT / "review" / "layla-talking-story-source-review.txt"


def collect():
    paths = subprocess.check_output(
        ["git", "-C", str(SOURCE_ROOT), "ls-files", "-z"]
    ).decode("utf-8").split("\0")
    selected = []
    for relative in paths:
        if not relative:
            continue
        path = Path(relative)
        if path.name in EXCLUDE or path.suffix.lower() not in ALLOWED_SUFFIXES:
            continue
        if path.parts[0] in {"dist", "node_modules", "review"}:
            continue
        source_path = SOURCE_ROOT / path
        if source_path.is_file():
            selected.append((relative, source_path.read_text(encoding="utf-8")))
    return sorted(selected, key=lambda p: p[0])


def main():
    files = collect()
    if not files or not any(name == "src/main.js" for name, _ in files):
        raise RuntimeError("Required source files could not be found")
    parts = [
        "LAYLA TALKING STORY MINI-APP — SOURCE CODE REVIEW",
        "=" * 80,
        "Encoding: UTF-8",
        "All text source/config/test files from the repository are combined below.",
        "Excluded as requested: public/app.json, public/icon.jpg and other images.",
        "Excluded generated/binary files: dist/, node_modules/, package-lock.json.",
        "Do not run this combined TXT as one program; each FILE section is separate.",
        "This snapshot is for review with Claude/Gemini.",
        "",
        f"File count: {len(files)}",
        "Files:",
        *(f"  - {name}" for name, _ in files),
        "",
    ]
    for name, content in files:
        parts.extend((
            "\n" + "=" * 80,
            f"FILE: {name}",
            "=" * 80,
            content.rstrip("\n"),
            f"END FILE: {name}",
            "",
        ))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"Created {OUTPUT.relative_to(SOURCE_ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

"""Build and install a versioned, locally signed CLI without changing macOS permissions."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def install():
    root = Path(__file__).resolve().parent
    subprocess.run(["swift", "build", "--package-path", str(root), "-c", "release", "-j", "4"], check=True)
    binary = root / ".build/release/clankie-desktop"
    verified = subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(binary)], check=True, capture_output=True, text=True)
    signature = subprocess.run(["codesign", "-d", "--verbose=4", str(binary)], check=True, capture_output=True, text=True)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    source_files = [root / "Package.swift", *sorted((root / "Sources").rglob("*.swift"))]
    sources = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
    destination = Path.home() / ".local/share/clankie/desktop" / digest[:16]
    destination.mkdir(parents=True, exist_ok=True)
    installed = destination / "clankie-desktop"
    if installed.exists():
        if hashlib.sha256(installed.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Existing versioned binary has a different hash")
    else:
        shutil.copy2(binary, installed)
    manifest = {"version": "0.1.0", "sourceRoot": str(root), "sourceHashes": sources,
                "binary": str(installed), "sha256": digest,
                "verification": verified.stderr, "signature": signature.stderr,
                "provenance": "Locally built Apache-2.0 Clankie source; ad-hoc signature, not notarized"}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    link = Path.home() / ".local/bin/clankie-desktop"
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.exists() or link.is_symlink():
        if not link.is_symlink() or not link.resolve().is_relative_to(destination.parent):
            raise RuntimeError("Refusing to replace a command outside this helper's versioned installation")
    temporary = link.with_name("clankie-desktop.install-" + str(os.getpid()))
    try:
        temporary.symlink_to(os.path.relpath(installed, link.parent))
        temporary.replace(link)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    install()

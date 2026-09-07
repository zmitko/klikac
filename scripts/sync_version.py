#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
(ROOT / "include" / "version.h").write_text(
    f'#pragma once\n\n#define FIRMWARE_VERSION "{version}"\n',
    encoding="utf-8",
)
pkg_path = ROOT / "desktop" / "package.json"
pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
pkg["version"] = version
pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")
print(version)

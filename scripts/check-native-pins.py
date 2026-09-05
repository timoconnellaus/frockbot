"""Verify qualification source and dependency pins without requiring Flutter."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
native = root / "apps/native"
manifest = json.loads((native / "qualification.json").read_text())
source = json.loads((native / "spec/a2ui-0.9.1/source.json").read_text())
for name, expected in manifest["implementationSha256"].items():
    assert hashlib.sha256((native / name).read_bytes()).hexdigest() == expected, f"Native implementation changed: {name}; requalify and record the new digest"
for name, expected in source["sha256"].items():
    assert hashlib.sha256((native / "spec/a2ui-0.9.1" / name).read_bytes()).hexdigest() == expected, f"Upstream A2UI bytes changed: {name}"
pubspec = (native / "pubspec.yaml").read_text()
lock = (native / "pubspec.lock").read_text()
for package, field in {"genui": "genui", "a2ui_core": "a2uiCore", "webview_flutter": "webviewFlutter", "webview_flutter_android": "webviewAndroid", "webview_flutter_wkwebview": "webviewWebkit", "flutter_secure_storage": "secureStorage"}.items():
    pin = re.escape(manifest[field])
    assert re.search(r'^  ' + package + r': [\"\x27]?' + pin + r'[\"\x27]?$', pubspec, re.M), f"Unpinned dependency: {package}"
    assert re.search(r'^  ' + package + r':\n(?:(?!^  \w).)*?    version: [\"\x27]?' + pin + r'[\"\x27]?$', lock, re.M | re.S), f"Lock differs: {package}"
assert re.search(r'^  flutter: [\"\x27]?' + re.escape(manifest["flutter"]) + r'[\"\x27]?$', pubspec, re.M)
assert manifest["frameworkRevision"] in (root / ".github/workflows/native.yml").read_text()
print("Native dependency pins, catalog implementation and A2UI source digests match.")

"""Verify qualification source and dependency pins without requiring Flutter."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
native = root / "apps/native"
manifest = json.loads((native / "qualification.json").read_text())
for name, expected in manifest["implementationSha256"].items():
    assert hashlib.sha256((native / name).read_bytes()).hexdigest() == expected, f"Native implementation changed: {name}; requalify and record the new digest"
pubspec = (native / "pubspec.yaml").read_text()
lock = (native / "pubspec.lock").read_text()
def check_pin(package, version):
    pin = re.escape(version)
    assert re.search(r'^  ' + package + r': [\"\x27]?' + pin + r'[\"\x27]?$', pubspec, re.M), f"Unpinned dependency: {package}"
    assert re.search(r'^  ' + package + r':\n(?:(?!^  \w).)*?    version: [\"\x27]?' + pin + r'[\"\x27]?$', lock, re.M | re.S), f"Lock differs: {package}"


for package, field in {"webview_flutter": "webviewFlutter", "webview_flutter_android": "webviewAndroid", "webview_flutter_wkwebview": "webviewWebkit", "flutter_secure_storage": "secureStorage"}.items():
    check_pin(package, manifest[field])
# The Shorebird patch flow's native plugins are pinned in the same manifest, so
# they drift the same way; restart_app in particular is what forces a new
# release baseline (apps/native/README.md).
for package, field in {"shorebird_code_push": "codePush", "restart_app": "restartApp"}.items():
    check_pin(package, manifest["shorebird"][field])
assert re.search(r'^  flutter: [\"\x27]?' + re.escape(manifest["flutter"]) + r'[\"\x27]?$', pubspec, re.M)
assert manifest["frameworkRevision"] in (root / ".github/workflows/native.yml").read_text()
print("Native dependency pins and vendored implementation digests match.")

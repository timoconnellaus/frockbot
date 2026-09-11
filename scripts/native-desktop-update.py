#!/usr/bin/env python3
"""Build, verify, and safely install the signed FrockBot macOS app."""

import argparse
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
NATIVE = ROOT / "apps/native"
FLUTTER = Path(os.environ.get("FROCKBOT_FLUTTER", "/Users/tim/repos/flutter/bin/flutter"))
BUILD_APP = NATIVE / "build/macos/Build/Products/Release/FrockBot.app"
INSTALL_APP = Path("/Users/tim/Applications/FrockBot.app")
BUNDLE_ID = "com.frockbot.mobile"
TEAM_ID = "Q444L76529"


def run(args, *, capture=False, check=True, **kwargs):
    return subprocess.run(
        [str(arg) for arg in args],
        check=check,
        text=True,
        capture_output=capture,
        **kwargs,
    )


def source_versions():
    pubspec = (NATIVE / "pubspec.yaml").read_text()
    version = re.search(r"^version:\s*(\d+\.\d+\.\d+)\+(\d+)\s*$", pubspec, re.M)
    transport = (NATIVE / "lib/client/transport.dart").read_text()
    protocol = re.search(r"'protocolVersion':\s*(\d+)", transport)
    compatibility = (ROOT / "core/protocol-schemas/compatibility.generated.ts").read_text()
    protocol_min = re.search(r"protocolMin:\s*(\d+)", compatibility)
    protocol_max = re.search(r"protocolMax:\s*(\d+)", compatibility)
    minimum_native = re.search(r'minimumNativeVersion:\s*"([^"]+)"', compatibility)
    if not all((version, protocol, protocol_min, protocol_max, minimum_native)):
        raise RuntimeError("Could not read the native app and protocol versions from source.")
    name, number = version.groups()
    client_protocol = int(protocol[1])
    if not int(protocol_min[1]) <= client_protocol <= int(protocol_max[1]):
        raise RuntimeError(
            f"Client protocol {client_protocol} is outside the supported "
            f"{protocol_min[1]}..{protocol_max[1]} range."
        )
    if tuple(map(int, name.split("."))) < tuple(map(int, minimum_native[1].split("."))):
        raise RuntimeError(f"Native version {name} is below the minimum {minimum_native[1]}.")
    return name, number, client_protocol


def inspect_app(app, expected_name, expected_number):
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError(f"Expected an app bundle, not a link or file: {app}")
    info_path = app / "Contents/Info.plist"
    executable = app / "Contents/MacOS/FrockBot"
    if not info_path.is_file() or not executable.is_file():
        raise RuntimeError(f"Incomplete FrockBot app bundle: {app}")
    with info_path.open("rb") as source:
        info = plistlib.load(source)
    actual = (
        info.get("CFBundleIdentifier"),
        str(info.get("CFBundleShortVersionString")),
        str(info.get("CFBundleVersion")),
    )
    expected = (BUNDLE_ID, expected_name, expected_number)
    if actual != expected:
        raise RuntimeError(f"App identity/version is {actual}, expected {expected}.")
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    details = run(["codesign", "-dv", "--verbose=4", app], capture=True)
    if f"TeamIdentifier={TEAM_ID}" not in details.stdout + details.stderr:
        raise RuntimeError(f"App is not signed by Apple team {TEAM_ID}.")
    return actual


def stop_running_app():
    running = run(["pgrep", "-x", "FrockBot"], capture=True, check=False)
    if running.returncode == 1:
        return
    if running.returncode != 0:
        raise RuntimeError("Could not determine whether FrockBot is running.")
    run(["osascript", "-e", 'tell application "FrockBot" to quit'])
    for _ in range(50):
        if run(["pgrep", "-x", "FrockBot"], capture=True, check=False).returncode == 1:
            return
        time.sleep(0.1)
    raise RuntimeError("FrockBot did not quit; the existing app was left untouched.")


def install(build, name, number):
    parent = INSTALL_APP.parent
    parent.mkdir(parents=True, exist_ok=True)
    if INSTALL_APP.exists() or INSTALL_APP.is_symlink():
        if INSTALL_APP.is_symlink():
            raise RuntimeError(f"Refusing to replace symlink: {INSTALL_APP}")
        with (INSTALL_APP / "Contents/Info.plist").open("rb") as source:
            if plistlib.load(source).get("CFBundleIdentifier") != BUNDLE_ID:
                raise RuntimeError(f"Refusing to replace a different app at {INSTALL_APP}.")

    with tempfile.TemporaryDirectory(prefix=".FrockBot-update-", dir=parent) as directory:
        temporary = Path(directory)
        staged = temporary / "FrockBot.app"
        backup = temporary / "previous.app"
        run(["ditto", build, staged])
        inspect_app(staged, name, number)
        stop_running_app()
        had_previous = INSTALL_APP.exists()
        if had_previous:
            INSTALL_APP.rename(backup)
        try:
            staged.rename(INSTALL_APP)
            inspect_app(INSTALL_APP, name, number)
        except BaseException:
            if INSTALL_APP.exists():
                shutil.rmtree(INSTALL_APP)
            if had_previous and backup.exists():
                backup.rename(INSTALL_APP)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="verify source versions and prerequisites without building or installing",
    )
    args = parser.parse_args()

    name, number, protocol = source_versions()
    if not FLUTTER.is_file():
        raise RuntimeError(f"Pinned Flutter executable is missing: {FLUTTER}")
    print(f"FrockBot macOS {name}+{number}; client protocol {protocol}; source {ROOT}")
    if args.dry_run:
        print(f"Would build with {FLUTTER} and install at {INSTALL_APP}")
        return

    run(["bun", "scripts/check-client-protocol.ts"], cwd=ROOT)
    run(
        [FLUTTER, "build", "macos", "--release", f"--build-name={name}", f"--build-number={number}",
         f"--dart-define=FROCKBOT_APP_VERSION={name}+{number}"],
        cwd=NATIVE,
    )
    inspect_app(BUILD_APP, name, number)
    install(BUILD_APP, name, number)
    run(["open", INSTALL_APP])
    print(f"Installed and opened {INSTALL_APP}: {name}+{number}, protocol {protocol}, team {TEAM_ID}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build, verify, and safely install the signed FrockBot Dev macOS app.

The local build is a separate app from the released one: "FrockBot Dev",
`com.frockbot.mobile.dev`, scheme `frockbot-dev`, a DEV-ribboned icon, installed
at ~/Applications/FrockBot Dev.app. Sharing the released identity let Launch
Services open a local build in place of /Applications/FrockBot.app, which then
never offered an update. The release workflow builds without the switch below
and so keeps `com.frockbot.mobile`.
"""

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
APP_NAME = "FrockBot Dev"
BUNDLE_ID = "com.frockbot.mobile.dev"
URL_SCHEME = "frockbot-dev"
RELEASE_BUNDLE_ID = "com.frockbot.mobile"
# Its own derived data, never flutter's build/macos: Xcode reuses the asset
# catalog's intermediate output, so a dev build beside a release build would
# leave the compiled AppIconDev.icns behind for the release bundle to copy in.
DERIVED_DATA = NATIVE / "build/macos-dev"
BUILD_APP = DERIVED_DATA / f"Build/Products/Release/{APP_NAME}.app"
INSTALL_APP = Path(f"/Users/tim/Applications/{APP_NAME}.app")
# Earlier local builds installed here under the released identity.
LEGACY_APP = Path("/Users/tim/Applications/FrockBot.app")
# Build outputs that carry the released identity and scheme (`flutter run`,
# `flutter build macos`), which Launch Services may otherwise prefer.
STALE_BUILDS = (
    DERIVED_DATA / "Build/Products/Release/FrockBot.app",
    DERIVED_DATA / "Build/Products/Debug/FrockBot.app",
)
LSREGISTER = Path(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework"
    "/Support/lsregister"
)
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
    executable = app / f"Contents/MacOS/{APP_NAME}"
    if not info_path.is_file() or not executable.is_file():
        raise RuntimeError(f"Incomplete {APP_NAME} app bundle: {app}")
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
    schemes = [scheme for kind in info.get("CFBundleURLTypes", []) for scheme in kind.get("CFBundleURLSchemes", [])]
    if schemes != [URL_SCHEME] or info.get("CFBundleName") != APP_NAME:
        raise RuntimeError(f"App name/scheme is {info.get('CFBundleName')!r} {schemes}, expected {APP_NAME!r} [{URL_SCHEME!r}].")
    if info.get("SUFeedURL") or info.get("SUPublicEDKey"):
        raise RuntimeError("A local build must not carry the release update feed.")
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    details = run(["codesign", "-dv", "--verbose=4", app], capture=True)
    if f"TeamIdentifier={TEAM_ID}" not in details.stdout + details.stderr:
        raise RuntimeError(f"App is not signed by Apple team {TEAM_ID}.")
    return actual


def stop_running_app():
    """Quit FrockBot Dev only; the released FrockBot keeps running."""
    running = run(["pgrep", "-x", APP_NAME], capture=True, check=False)
    if running.returncode == 1:
        return
    if running.returncode != 0:
        raise RuntimeError(f"Could not determine whether {APP_NAME} is running.")
    run(["osascript", "-e", f'tell application id "{BUNDLE_ID}" to quit'])
    for _ in range(50):
        if run(["pgrep", "-x", APP_NAME], capture=True, check=False).returncode == 1:
            return
        time.sleep(0.1)
    raise RuntimeError(f"{APP_NAME} did not quit; the existing app was left untouched.")


def legacy_install_notice(app=LEGACY_APP):
    """Explain an earlier local build left under the released identity, if any.

    It is never removed here: it may hold something Tim wants, and deleting an
    app is his call. While it exists, macOS may open it instead of the released
    /Applications/FrockBot.app, which then never offers an update.
    """
    info_path = app / "Contents/Info.plist"
    if app.is_symlink() or not info_path.is_file():
        return None
    with info_path.open("rb") as source:
        info = plistlib.load(source)
    if info.get("CFBundleIdentifier") != RELEASE_BUNDLE_ID or info.get("SUFeedURL"):
        return None
    return (
        f"Note: {app} is an earlier local build carrying the released app's identity "
        f"({RELEASE_BUNDLE_ID}) without its update feed. macOS may open it instead of "
        f"/Applications/FrockBot.app, which then never shows Update. The local build is now "
        f"{INSTALL_APP}. Quit it and remove it when you are ready:\n"
        f"  rm -rf '{app}'"
    )


def install(build, name, number):
    parent = INSTALL_APP.parent
    parent.mkdir(parents=True, exist_ok=True)
    if INSTALL_APP.exists() or INSTALL_APP.is_symlink():
        if INSTALL_APP.is_symlink():
            raise RuntimeError(f"Refusing to replace symlink: {INSTALL_APP}")
        with (INSTALL_APP / "Contents/Info.plist").open("rb") as source:
            if plistlib.load(source).get("CFBundleIdentifier") != BUNDLE_ID:
                raise RuntimeError(f"Refusing to replace a different app at {INSTALL_APP}.")

    with tempfile.TemporaryDirectory(prefix=".FrockBot-Dev-update-", dir=parent) as directory:
        temporary = Path(directory)
        staged = temporary / f"{APP_NAME}.app"
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


def register_installed_app():
    """Make the installed bundle the one Launch Services opens `frockbot-dev://` links with.

    The build output carries the same identifier and scheme as the installed
    FrockBot Dev, and `flutter run` outputs carry the released identity. Left
    registered, Launch Services may hand a browser return to one of them and
    launch a copy that is not running. The released /Applications/FrockBot.app
    is never touched.
    """
    if not LSREGISTER.is_file():
        raise RuntimeError(f"Launch Services registration tool is missing: {LSREGISTER}")
    for stale in (BUILD_APP, *STALE_BUILDS):
        run([LSREGISTER, "-u", stale], check=False)
    run([LSREGISTER, "-f", INSTALL_APP])


def build_commands(name, number):
    """Flutter writes the build configuration; xcodebuild builds the dev identity.

    `flutter build macos` cannot pass build settings to xcodebuild, and a
    development profile for a new bundle identifier needs
    `-allowProvisioningUpdates`, so the build runs the way the release workflow
    does: `--config-only`, then xcodebuild with `FROCKBOT_DESKTOP_DEV=YES`, the
    switch `macos/Runner/Configs/AppInfo.xcconfig` reads.
    """
    return [
        [FLUTTER, "build", "macos", "--release", "--config-only", f"--build-name={name}",
         f"--build-number={number}", f"--dart-define=FROCKBOT_APP_VERSION={name}+{number}",
         "--dart-define=FROCKBOT_DESKTOP_DEV=true"],
        ["xcodebuild", "build", "-workspace", "macos/Runner.xcworkspace", "-scheme", "Runner",
         "-configuration", "Release", "-derivedDataPath", DERIVED_DATA,
         "-destination", "platform=macOS", "-allowProvisioningUpdates", "FROCKBOT_DESKTOP_DEV=YES"],
    ]


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
    print(f"{APP_NAME} macOS {name}+{number} ({BUNDLE_ID}); client protocol {protocol}; source {ROOT}")
    notice = legacy_install_notice()
    if notice:
        print(notice)
    if args.dry_run:
        print(f"Would build with {FLUTTER} and install at {INSTALL_APP}")
        return

    run(["bun", "scripts/check-client-protocol.ts"], cwd=ROOT)
    for command in build_commands(name, number):
        run(command, cwd=NATIVE)
    inspect_app(BUILD_APP, name, number)
    install(BUILD_APP, name, number)
    register_installed_app()
    run(["open", INSTALL_APP])
    print(f"Installed and opened {INSTALL_APP}: {name}+{number}, protocol {protocol}, team {TEAM_ID}")
    if notice:
        print(notice)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""The local Mac build is FrockBot Dev and never takes the released app's identity."""

import importlib.util
from pathlib import Path
import plistlib
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("desktop_update", ROOT / "scripts/native-desktop-update.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


def write_app(parent, name, info):
    app = Path(parent) / f"{name}.app"
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / f"Contents/MacOS/{name}").write_text("")
    with (app / "Contents/Info.plist").open("wb") as target:
        plistlib.dump(info, target)
    return app


def dev_info(**overrides):
    return {
        "CFBundleIdentifier": "com.frockbot.mobile.dev",
        "CFBundleName": "FrockBot Dev",
        "CFBundleShortVersionString": "1.4.0",
        "CFBundleVersion": "2",
        "CFBundleURLTypes": [{"CFBundleURLSchemes": ["frockbot-dev"]}],
        "SUFeedURL": "",
        "SUPublicEDKey": "",
        **overrides,
    }


class DesktopUpdateTest(unittest.TestCase):
    def test_build_identity_and_origin_come_from_checked_metadata(self):
        desktop.source_metadata.cache_clear()
        metadata = SimpleNamespace(
            version_name="9.8.7",
            build_number=42,
            client_protocol=3,
            hosted_origin="https://desktop.example",
        )
        try:
            with mock.patch.object(
                desktop, "read_native_metadata", return_value=metadata
            ):
                self.assertEqual(desktop.source_versions(), ("9.8.7", "42", 3))
                self.assertEqual(desktop.hosted_origin(), "https://desktop.example")
        finally:
            desktop.source_metadata.cache_clear()

    def test_malformed_metadata_stops_before_build_commands_are_made(self):
        desktop.source_metadata.cache_clear()
        try:
            with mock.patch.object(
                desktop,
                "read_native_metadata",
                side_effect=RuntimeError("malformed native metadata"),
            ):
                with self.assertRaisesRegex(RuntimeError, "malformed native metadata"):
                    desktop.source_versions()
        finally:
            desktop.source_metadata.cache_clear()

    def test_targets_the_dev_identity_beside_the_released_app(self):
        self.assertEqual(desktop.BUNDLE_ID, "com.frockbot.mobile.dev")
        self.assertEqual(desktop.INSTALL_APP, Path("/Users/tim/Applications/FrockBot Dev.app"))
        self.assertNotIn(Path("/Applications/FrockBot.app"), (desktop.INSTALL_APP, desktop.BUILD_APP))
        self.assertEqual(desktop.BUILD_APP.name, "FrockBot Dev.app")

    def test_the_dev_build_keeps_its_own_derived_data(self):
        # flutter builds the released identity in apps/native/build/macos. Xcode
        # reuses the asset catalog's intermediate output, so a dev build in that
        # same tree would leave AppIconDev.icns for the release bundle to copy in.
        self.assertNotEqual(desktop.DERIVED_DATA,
                            ROOT / "apps/native" / "build/macos")
        self.assertEqual(desktop.BUILD_APP,
                         desktop.DERIVED_DATA / "Build/Products/Release/FrockBot Dev.app")

    def test_build_switches_on_the_dev_identity_in_both_dart_and_xcode(self):
        flutter, xcodebuild = desktop.build_commands("1.4.0", "2")
        self.assertIn("--config-only", flutter)
        self.assertIn("--dart-define=FROCKBOT_DESKTOP_DEV=true", flutter)
        # A development build names no release, so the app says so.
        self.assertFalse(any("FROCKBOT_RELEASE" in str(arg) for arg in flutter))
        self.assertEqual(xcodebuild[0], "xcodebuild")
        self.assertIn("FROCKBOT_DESKTOP_DEV=YES", xcodebuild)
        self.assertIn("-allowProvisioningUpdates", xcodebuild)
        # Only the switch: a command-line PRODUCT_NAME or bundle identifier
        # would rename every framework target too.
        self.assertFalse(any(str(arg).startswith(("PRODUCT_", "FROCKBOT_UPDATE")) for arg in xcodebuild))

    def test_voice_diagnostics_are_opt_in_for_the_dev_build(self):
        normal, _ = desktop.build_commands("1.4.0", "2")
        diagnostic, xcodebuild = desktop.build_commands("1.4.0", "2", voice_diagnostics=True)
        flag = "--dart-define=FROCKBOT_VOICE_DIAGNOSTICS=true"
        self.assertNotIn(flag, normal)
        self.assertIn(flag, diagnostic)
        self.assertIn("--dart-define=FROCKBOT_DESKTOP_DEV=true", diagnostic)
        self.assertIn("FROCKBOT_DESKTOP_DEV=YES", xcodebuild)

    def test_xcode_defaults_are_the_released_identity(self):
        config = (ROOT / "apps/native/macos/Runner/Configs/AppInfo.xcconfig").read_text()
        settings = dict(re.findall(r"^(\w+) = (.*)$", config, re.M))

        def resolve(name, switch):
            def expand(match):
                inner = re.sub(r"\$\((\w+)\)", lambda m: switch if m[1] == "FROCKBOT_DESKTOP_DEV" else settings.get(m[1], ""), match[1])
                return settings.get(inner, "")
            value = settings[name]
            while "$(" in value:
                value = re.sub(r"\$\(([\w$()]+)\)", expand, value, count=1)
            return value

        release = {k: resolve(k, "") for k in ("PRODUCT_NAME", "PRODUCT_BUNDLE_IDENTIFIER", "FROCKBOT_URL_SCHEME", "FROCKBOT_APP_ICON")}
        dev = {k: resolve(k, "YES") for k in release}
        self.assertEqual(release, {"PRODUCT_NAME": "FrockBot", "PRODUCT_BUNDLE_IDENTIFIER": "com.frockbot.mobile",
                                   "FROCKBOT_URL_SCHEME": "frockbot", "FROCKBOT_APP_ICON": "AppIcon"})
        self.assertEqual(dev, {"PRODUCT_NAME": "FrockBot Dev", "PRODUCT_BUNDLE_IDENTIFIER": "com.frockbot.mobile.dev",
                               "FROCKBOT_URL_SCHEME": "frockbot-dev", "FROCKBOT_APP_ICON": "AppIconDev"})
        icons = ROOT / "apps/native/macos/Runner/Assets.xcassets"
        self.assertEqual(sorted(p.name for p in (icons / "AppIcon.appiconset").iterdir()),
                         sorted(p.name for p in (icons / "AppIconDev.appiconset").iterdir()))

    def test_inspection_rejects_the_released_identity_and_a_feed(self):
        with tempfile.TemporaryDirectory() as parent, mock.patch.object(desktop, "run") as run:
            run.return_value.stdout = f"TeamIdentifier={desktop.TEAM_ID}"
            run.return_value.stderr = ""
            good = write_app(Path(parent) / "good", "FrockBot Dev", dev_info())
            self.assertEqual(desktop.inspect_app(good, "1.4.0", "2")[0], "com.frockbot.mobile.dev")
            for case, info in {
                "released": dev_info(CFBundleIdentifier="com.frockbot.mobile"),
                "scheme": dev_info(CFBundleURLTypes=[{"CFBundleURLSchemes": ["frockbot"]}]),
                "feed": dev_info(SUFeedURL="https://downloads.frockbot.com/mac/appcast.xml"),
            }.items():
                app = write_app(Path(parent) / case, "FrockBot Dev", info)
                with self.assertRaises(RuntimeError, msg=case):
                    desktop.inspect_app(app, "1.4.0", "2")

    def test_only_the_dev_app_is_quit(self):
        calls = []

        def fake(args, **_):
            calls.append([str(a) for a in args])
            result = mock.Mock()
            result.returncode = 0 if len(calls) == 1 else 1
            return result

        with mock.patch.object(desktop, "run", side_effect=fake):
            desktop.stop_running_app()
        self.assertEqual(calls[0], ["pgrep", "-x", "FrockBot Dev"])
        self.assertEqual(calls[1], ["osascript", "-e", 'tell application id "com.frockbot.mobile.dev" to quit'])

    def test_an_old_same_identity_local_build_is_reported_not_removed(self):
        with tempfile.TemporaryDirectory() as parent:
            legacy = write_app(parent, "FrockBot", dev_info(CFBundleIdentifier="com.frockbot.mobile", CFBundleName="FrockBot",
                                                         CFBundleURLTypes=[{"CFBundleURLSchemes": ["frockbot"]}]))
            notice = desktop.legacy_install_notice(legacy)
            self.assertIn(str(legacy), notice)
            self.assertIn("rm -rf", notice)
            self.assertTrue(legacy.exists())
        with tempfile.TemporaryDirectory() as parent:
            # A copy of the released app keeps its feed and is not a stale local build.
            released = write_app(parent, "FrockBot", dev_info(CFBundleIdentifier="com.frockbot.mobile",
                                                           SUFeedURL="https://downloads.frockbot.com/mac/appcast.xml"))
            self.assertIsNone(desktop.legacy_install_notice(released))
            self.assertIsNone(desktop.legacy_install_notice(Path(parent) / "Missing.app"))


if __name__ == "__main__":
    unittest.main()

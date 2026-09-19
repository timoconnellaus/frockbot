#!/usr/bin/env python3
"""Acceptance builds consume checked release metadata before touching Flutter."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "native_acceptance", ROOT / "scripts/native-acceptance.py"
)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class NativeAcceptanceTest(unittest.TestCase):
    def test_build_command_uses_checked_identity_and_origin(self):
        metadata = SimpleNamespace(
            version_name="9.8.7", hosted_origin="https://acceptance.example"
        )
        with mock.patch.object(
            acceptance, "read_native_metadata", return_value=metadata
        ):
            command = acceptance.build_command("flutter", 41)
        self.assertEqual(
            command,
            [
                "flutter",
                "build",
                "apk",
                "--release",
                "--build-name=9.8.7",
                "--build-number=42",
                "--dart-define=FROCKBOT_ORIGIN=https://acceptance.example",
                "--dart-define=NATIVE_ACCEPTANCE=true",
            ],
        )

    def test_malformed_metadata_stops_before_a_build_command_exists(self):
        with mock.patch.object(
            acceptance,
            "read_native_metadata",
            side_effect=RuntimeError("malformed native metadata"),
        ):
            with self.assertRaisesRegex(RuntimeError, "malformed native metadata"):
                acceptance.build_command("flutter", 41)


if __name__ == "__main__":
    unittest.main()

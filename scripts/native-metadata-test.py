#!/usr/bin/env python3
"""The Python release boundary accepts only complete checked metadata."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import native_metadata


DOCUMENT = {
    "schemaVersion": 1,
    "release": "0.7.163",
    "app": {"versionName": "0.7.163", "buildNumber": 1, "version": "0.7.163+1"},
    "hostedOrigin": "https://bot.frockbot.test",
    "clientProtocol": 1,
    "compatibility": {"protocolMin": 1, "protocolMax": 1},
}


class NativeMetadataTest(unittest.TestCase):
    def test_decodes_the_checked_document(self):
        metadata = native_metadata.decode_native_metadata(json.dumps(DOCUMENT))
        self.assertEqual(metadata.release, "0.7.163")
        self.assertEqual(metadata.version_name, "0.7.163")
        self.assertEqual(metadata.build_number, 1)
        self.assertEqual(metadata.hosted_origin, "https://bot.frockbot.test")
        self.assertEqual(metadata.client_protocol, 1)

    def test_rejects_malformed_command_output(self):
        for document in (
            "not json",
            json.dumps({**DOCUMENT, "schemaVersion": 2}),
            json.dumps({**DOCUMENT, "clientProtocol": "1"}),
            json.dumps({**DOCUMENT, "app": {**DOCUMENT["app"], "version": "0.7.163+8"}}),
            json.dumps({**DOCUMENT, "release": ""}),
            json.dumps({k: v for k, v in DOCUMENT.items() if k != "release"}),
            json.dumps({**DOCUMENT, "hostedOrigin": "http://bot.frockbot.test"}),
        ):
            with self.subTest(document=document), self.assertRaises(RuntimeError):
                native_metadata.decode_native_metadata(document)

    def test_command_failure_is_actionable(self):
        failure = subprocess.CompletedProcess([], 1, stdout="", stderr="bad source")
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            native_metadata.subprocess, "run", return_value=failure
        ):
            with self.assertRaisesRegex(RuntimeError, "bad source"):
                native_metadata.read_native_metadata(Path(root))

    def test_command_result_uses_the_shared_decoder(self):
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(DOCUMENT), stderr="")
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            native_metadata.subprocess, "run", return_value=result
        ) as run:
            metadata = native_metadata.read_native_metadata(Path(root))
        self.assertEqual(metadata.version, "0.7.163+1")
        self.assertEqual(run.call_args.args[0][0], "bun")
        self.assertIn("--root", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()

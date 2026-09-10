import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("mac-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleaseTests(unittest.TestCase):
    def test_signing_preconditions_fail_before_build(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release, "run") as run:
            for identity, profile, provisioning in [
                ("Apple Distribution: Test", "profile", "/tmp/profile"),
                ("Developer ID Application: Test", None, None),
                ("Developer ID Application: Test", "profile", None),
            ]:
                with self.assertRaises(ValueError):
                    release.build("1.1.0", Path(temporary), identity, profile, provisioning)
            run.assert_not_called()
    def test_invalid_version_fails_before_build(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release, "run") as run:
            with self.assertRaises(ValueError): release.build("bad", Path(temporary))
            run.assert_not_called()

if __name__ == "__main__": unittest.main()

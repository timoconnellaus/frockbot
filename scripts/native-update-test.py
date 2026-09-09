import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("updates", Path(__file__).with_name("native-update.py"))
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


class UpdatesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state = patch.object(updates, "STATE", Path(self.directory.name))
        self.state.start()

    def tearDown(self):
        self.state.stop()
        self.directory.cleanup()

    def test_lock_contention_has_an_actionable_error(self):
        with patch.object(updates.fcntl, "flock", side_effect=BlockingIOError):
            with self.assertRaisesRegex(RuntimeError, "already running"):
                updates.main(["build"])

    def test_rejected_release_keeps_previous_download(self):
        previous = {"versionCode": 50, "file": "old.apk"}
        (updates.STATE / "latest.json").write_text(json.dumps(previous))
        with patch.object(updates, "inspect_apk", return_value={"versionCode": 49}):
            with self.assertRaisesRegex(RuntimeError, "does not advance"):
                updates.publish(Path("candidate.apk"))
        self.assertEqual(updates.latest(), previous)

    def test_dev_package_is_rejected(self):
        with patch.object(updates, "build_tool", lambda name: Path(name)), \
                patch.object(updates, "run", return_value="package: name='com.frockbot.mobile.dev' versionCode='60' versionName='1.1.0'"):
            with self.assertRaisesRegex(RuntimeError, "normal FrockBot"):
                updates.inspect_apk(Path("dev.apk"))

    def test_different_signer_is_rejected(self):
        outputs = ["package: name='com.frockbot.mobile' versionCode='60' versionName='1.1.0'",
                   "Signer #1 certificate SHA-256 digest: deadbeef"]
        with patch.object(updates, "build_tool", lambda name: Path(name)), \
                patch.object(updates, "run", side_effect=outputs):
            with self.assertRaisesRegex(RuntimeError, "signer differs"):
                updates.inspect_apk(Path("wrong-key.apk"))

    def test_newest_build_tools_version_is_used(self):
        sdk = updates.STATE / "sdk"
        for version in ("9.0.0", "36.0.0", "35.0.1"):
            tool = sdk / "build-tools" / version / "aapt"
            tool.parent.mkdir(parents=True)
            tool.write_text("")
        with patch.dict(os.environ, {"ANDROID_HOME": str(sdk)}):
            self.assertEqual(updates.build_tool("aapt"), sdk / "build-tools/36.0.0/aapt")

    def test_missing_build_tools_are_reported_clearly(self):
        with patch.dict(os.environ, {"ANDROID_HOME": str(updates.STATE / "empty-sdk")}):
            with self.assertRaisesRegex(RuntimeError, "No Android build-tools aapt"):
                updates.build_tool("aapt")

    def test_download_and_no_directory_access(self):
        (updates.STATE / "release.apk").write_bytes(b"complete apk")
        (updates.STATE / "latest.json").write_text(json.dumps({"versionCode": 50, "file": "release.apk"}))
        (updates.STATE / "private.txt").write_text("must not be served")
        server = updates.ThreadingHTTPServer(("127.0.0.1", 0), updates.Downloads)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(url + "/frockbot.apk") as response:
                self.assertEqual(response.read(), b"complete apk")
                self.assertEqual(response.headers["Content-Type"], "application/vnd.android.package-archive")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            for route in ("/", "/private.txt", "/../private.txt"):
                with self.assertRaises(HTTPError) as result:
                    urlopen(url + route)
                self.assertEqual(result.exception.code, 404)
                result.exception.close()
            (updates.STATE / "release.apk").unlink()
            with self.assertRaises(HTTPError) as result:
                urlopen(url + "/frockbot.apk")
            self.assertEqual(result.exception.code, 503)
            result.exception.close()
            (updates.STATE / "latest.json").unlink()
            with self.assertRaises(HTTPError) as result:
                urlopen(url + "/frockbot.apk")
            self.assertEqual(result.exception.code, 503)
            result.exception.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_head_serves_only_the_download_routes(self):
        (updates.STATE / "release.apk").write_bytes(b"complete apk")
        (updates.STATE / "latest.json").write_text(json.dumps({"versionCode": 50, "file": "release.apk"}))
        (updates.STATE / "shorebird-private.pem").write_text("must not be served")
        server = updates.ThreadingHTTPServer(("127.0.0.1", 0), updates.Downloads)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(Request(url + "/frockbot.apk", method="HEAD")) as response:
                self.assertEqual(response.headers["Content-Length"], str(len(b"complete apk")))
                self.assertEqual(response.read(), b"")
            with urlopen(Request(url + "/health", method="HEAD")) as response:
                self.assertEqual(response.status, 200)
            for route in ("/shorebird-private.pem", "/baseline.json", "/pending-release.json"):
                with self.assertRaises(HTTPError) as result:
                    urlopen(Request(url + route, method="HEAD"))
                self.assertEqual(result.exception.code, 404)
                result.exception.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


SIGNER = updates.SIGNER
PUBLIC_DER = b"rsa-public-der"
APP_ID = "fab29f02-321e-4be1-b478-68dff4398073"
NOW = 1788941465


class ShorebirdHarness(unittest.TestCase):
    """Everything outside the script is faked at the subprocess boundary."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.state = root / "state"
        self.state.mkdir()
        self.cli = root / "shorebird"
        self.cli.write_text("#!/bin/sh\n")
        self.public = root / "shorebird-public-key.pem"
        self.public.write_text("-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----\n")
        self.yaml = root / "shorebird.yaml"
        self.yaml.write_text(f"# comment\napp_id: {APP_ID}\n")
        self.apk = root / "app-release.apk"
        for tool in ("aapt", "apksigner"):
            path = root / "sdk/build-tools/36.0.0" / tool
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("")
        self.environ = {**os.environ, "NATIVE_SHOREBIRD": str(self.cli), "ANDROID_HOME": str(root / "sdk")}
        self.environ.pop("NATIVE_SHOREBIRD_PRIVATE_KEY", None)
        self.calls = []
        self.commands = []
        self.head = "a" * 40
        self.dirty = ""
        self.private_der = PUBLIC_DER
        self.embedded_app_id = APP_ID
        self.embedded_der = PUBLIC_DER
        self.signer = SIGNER
        self.built = None
        self.failure = None
        self.cli_version = "1.6.120"
        self.patches = [
            patch.object(updates, "STATE", self.state), patch.object(updates, "PUBLIC_KEY", self.public),
            patch.object(updates, "SHOREBIRD_YAML", self.yaml), patch.object(updates, "APK_OUTPUT", self.apk),
            patch.object(updates, "run", self.fake_run), patch.object(updates.subprocess, "run", self.fake_command),
            patch.object(updates.time, "time", lambda: NOW), patch.dict(os.environ, self.environ, clear=True),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def fake_run(self, args, *, binary=False, **kwargs):
        args = [str(a) for a in args]
        self.calls.append(args)
        if args[:2] == ["git", "rev-parse"]:
            return self.head + "\n"
        if args[:2] == ["git", "status"]:
            return self.dirty
        if args[1:] == ["--version"]:
            return f"Shorebird {self.cli_version} • git@github.com:shorebirdtech/shorebird.git\n"
        if args[:3] == ["openssl", "rsa", "-pubin"]:
            return PUBLIC_DER
        if args[:2] == ["openssl", "rsa"]:
            return self.private_der
        if args[1:3] == ["dump", "badging"]:
            return f"package: name='com.frockbot.mobile' versionCode='{self.built}' versionName='1.1.0'"
        if args[1:2] == ["verify"]:
            return f"Signer #1 certificate SHA-256 digest: {self.signer}"
        raise AssertionError(f"unexpected command {args}")

    def fake_command(self, args, **kwargs):
        args = [str(a) for a in args]
        self.commands.append((args, kwargs))
        if self.failure:
            raise subprocess.CalledProcessError(1, args)
        if args[1] == "release":
            self.built = int(next(a for a in args if a.startswith("--build-number=")).split("=")[1])
            with zipfile.ZipFile(self.apk, "w") as archive:
                archive.writestr("classes.dex", os.urandom(16))
                archive.writestr(updates.EMBEDDED_YAML, f"app_id: {self.embedded_app_id}\n"
                                 f"patch_public_key: {base64.b64encode(self.embedded_der).decode()}\n")
        return subprocess.CompletedProcess(args, 0)

    def shorebird(self):
        return [(a, k) for a, k in self.commands if a[0] == str(self.cli)]

    def baseline(self):
        return json.loads((self.state / "baseline.json").read_text())


class ReleaseTest(ShorebirdHarness):
    def test_release_runs_the_signed_shorebird_release_and_publishes(self):
        record = updates.release()
        (args, kwargs), = self.shorebird()
        self.assertEqual(args, [
            str(self.cli), "release", "android", "--flutter-version=3.47.0", "--artifact=apk",
            "--target-platform=android-arm64", "--build-name=1.1.0", f"--build-number={NOW}",
            f"--public-key-path={self.public}"])
        self.assertEqual(kwargs["cwd"], updates.NATIVE)
        self.assertEqual(kwargs["env"]["FROCKBOT_ANDROID_VERSION_FLOOR"], "0")
        self.assertTrue(kwargs["check"])
        self.assertEqual(record["releaseVersion"], f"1.1.0+{NOW}")
        self.assertEqual(record["appId"], APP_ID)
        self.assertEqual(record["shorebirdCli"], "1.6.120")
        self.assertEqual(record["signerSha256"], SIGNER)
        self.assertEqual(record["gitHead"], self.head)
        self.assertEqual(record["releaseArgs"], args[1:])
        self.assertEqual(self.baseline(), record)
        published = updates.latest()
        self.assertEqual(published["versionCode"], NOW)
        self.assertEqual(published["file"], f"frockbot-{NOW}-{published['sha256']}.apk")
        self.assertEqual(record["file"], published["file"])
        self.assertTrue((self.state / published["file"]).exists())
        self.assertFalse((self.state / "pending-release.json").exists())

    def test_wrong_built_version_does_not_replace_download(self):
        original = self.fake_command
        def wrong_version(args, **kwargs):
            result = original(args, **kwargs)
            self.built += 1
            return result
        with patch.object(updates.subprocess, "run", wrong_version):
            with self.assertRaisesRegex(RuntimeError, "expected"):
                updates.release()
        self.assertIsNone(updates.latest())

    def test_dirty_source_never_uploads(self):
        self.dirty = " M apps/native/lib/main.dart"
        with self.assertRaisesRegex(RuntimeError, "Commit"):
            updates.release()
        self.assertEqual(self.commands, [])

    def test_release_advances_past_the_published_and_known_floors(self):
        (self.state / "latest.json").write_text(json.dumps({"versionCode": NOW + 5, "file": "x.apk"}))
        updates.release(floor=NOW + 2)
        (args, kwargs), = self.shorebird()
        self.assertIn(f"--build-number={NOW + 6}", args)
        self.assertEqual(kwargs["env"]["FROCKBOT_ANDROID_VERSION_FLOOR"], str(NOW + 5))
        self.assertEqual(self.baseline()["versionFloor"], NOW + 5)

    def test_failed_release_keeps_its_intent_and_retries_the_same_version(self):
        self.failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            updates.release()
        pending = json.loads((self.state / "pending-release.json").read_text())
        self.assertEqual(pending["versionCode"], NOW)
        self.assertIsNone(updates.latest())
        self.assertFalse((self.state / "baseline.json").exists())
        self.failure = None
        with patch.object(updates.time, "time", lambda: NOW + 100):
            updates.release()
        self.assertIn(f"--build-number={NOW}", self.shorebird()[-1][0])
        self.assertEqual(updates.latest()["versionCode"], NOW)
        self.assertFalse((self.state / "pending-release.json").exists())

    def test_retry_after_a_cli_upgrade_records_the_cli_that_built_the_release(self):
        self.failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            updates.release()
        self.assertEqual(json.loads((self.state / "pending-release.json").read_text())["shorebirdCli"], "1.6.120")
        self.failure = None
        self.cli_version = "1.7.0"
        record = updates.release()
        self.assertEqual(record["shorebirdCli"], "1.7.0")
        self.assertEqual(record["releaseArgs"], self.shorebird()[-1][0][1:])
        self.assertEqual(self.baseline(), record)
        (self.state / "shorebird-private.pem").write_text("private\n")
        updates.patch()
        self.assertEqual(self.baseline()["patches"][-1]["track"], "staging")

    def test_a_pending_intent_without_identity_fails_with_a_reconcile_message(self):
        (self.state / "pending-release.json").write_text(json.dumps(
            {"versionCode": NOW, "releaseVersion": f"1.1.0+{NOW}", "createdAt": "2026-01-01T00:00:00Z",
             "gitHead": self.head, "workingTreeDirty": False}))
        with self.assertRaisesRegex(RuntimeError, "predates full release-identity recording"):
            updates.release()
        with self.assertRaisesRegex(RuntimeError, "predates full release-identity recording"):
            updates.release(build_number=NOW + 1)
        self.assertEqual(self.commands, [])
        self.assertTrue((self.state / "pending-release.json").exists())

    def test_release_intent_records_recovery_identity_before_upload(self):
        original = self.fake_command
        captured = {}
        def capture_intent(args, **kwargs):
            captured.update(json.loads((self.state / "pending-release.json").read_text()))
            return original(args, **kwargs)
        with patch.object(updates.subprocess, "run", capture_intent):
            updates.release()
        self.assertEqual(captured["package"], "com.frockbot.mobile")
        self.assertEqual(captured["appId"], APP_ID)
        self.assertEqual(captured["buildName"], "1.1.0")
        self.assertEqual(captured["buildNumber"], NOW)
        self.assertEqual(captured["releaseVersion"], f"1.1.0+{NOW}")
        self.assertEqual(captured["versionFloor"], 0)
        self.assertEqual(captured["shorebirdCli"], "1.6.120")
        self.assertEqual(captured["signerSha256"], SIGNER)
        self.assertEqual(captured["publicKeySha256"], hashlib.sha256(PUBLIC_DER).hexdigest())
        self.assertEqual(captured["gitHead"], self.head)

    def test_retry_finalizes_published_release_after_baseline_write_failure(self):
        original = updates.write_atomic
        fail_once = True
        def fail_baseline(path, text):
            nonlocal fail_once
            if fail_once and Path(path).name == "baseline.json":
                fail_once = False
                raise OSError("baseline unavailable")
            return original(path, text)
        with patch.object(updates, "write_atomic", fail_baseline):
            with self.assertRaisesRegex(OSError, "baseline unavailable"):
                updates.release()
            self.assertEqual(len(self.shorebird()), 1)
            self.assertEqual(updates.latest()["versionCode"], NOW)
            self.assertTrue((self.state / "pending-release.json").exists())
            self.assertFalse((self.state / "baseline.json").exists())
            record = updates.release()
        self.assertEqual(len(self.shorebird()), 1)
        self.assertEqual(record, self.baseline())
        self.assertEqual(record["buildNumber"], NOW)
        self.assertEqual(record["apkSha256"], updates.latest()["sha256"])
        self.assertFalse((self.state / "pending-release.json").exists())

    def test_retry_rejects_mismatched_published_release_identity(self):
        original = updates.write_atomic
        fail_once = True
        def fail_baseline(path, text):
            nonlocal fail_once
            if fail_once and Path(path).name == "baseline.json":
                fail_once = False
                raise OSError("baseline unavailable")
            return original(path, text)
        with patch.object(updates, "write_atomic", fail_baseline):
            with self.assertRaisesRegex(OSError, "baseline unavailable"):
                updates.release()
        published = updates.latest()
        published["signerSha256"] = "0" * 64
        (self.state / "latest.json").write_text(json.dumps(published))
        with self.assertRaisesRegex(RuntimeError, "Published release identity.*signerSha256"):
            updates.release()
        self.assertEqual(len(self.shorebird()), 1)
        self.assertTrue((self.state / "pending-release.json").exists())
        self.assertFalse((self.state / "baseline.json").exists())

    def test_retry_rejects_published_apk_with_a_different_actual_version(self):
        original = updates.write_atomic
        fail_once = True
        def fail_baseline(path, text):
            nonlocal fail_once
            if fail_once and Path(path).name == "baseline.json":
                fail_once = False
                raise OSError("baseline unavailable")
            return original(path, text)
        with patch.object(updates, "write_atomic", fail_baseline):
            with self.assertRaisesRegex(OSError, "baseline unavailable"):
                updates.release()
        self.built += 1
        with self.assertRaisesRegex(RuntimeError, "Published APK version differs"):
            updates.release()
        self.assertEqual(len(self.shorebird()), 1)
        self.assertTrue((self.state / "pending-release.json").exists())
        self.assertFalse((self.state / "baseline.json").exists())

    def test_retry_accepts_the_same_public_key_from_another_checkout_path(self):
        original = updates.write_atomic
        fail_once = True
        def fail_baseline(path, text):
            nonlocal fail_once
            if fail_once and Path(path).name == "baseline.json":
                fail_once = False
                raise OSError("baseline unavailable")
            return original(path, text)
        with patch.object(updates, "write_atomic", fail_baseline):
            with self.assertRaisesRegex(OSError, "baseline unavailable"):
                updates.release()
        relocated = self.state / "another-checkout/shorebird-public-key.pem"
        relocated.parent.mkdir()
        relocated.write_text(self.public.read_text())
        with patch.object(updates, "PUBLIC_KEY", relocated):
            record = updates.release()
        self.assertEqual(len(self.shorebird()), 1)
        self.assertEqual(record, self.baseline())
        self.assertFalse((self.state / "pending-release.json").exists())

    def test_pending_release_rejects_a_different_explicit_version(self):
        self.failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            updates.release()
        self.failure = None
        with self.assertRaisesRegex(RuntimeError, "pending"):
            updates.release(build_number=NOW + 1)
        self.assertEqual(len(self.shorebird()), 1)
        updates.release(build_number=NOW)
        self.assertEqual(updates.latest()["versionCode"], NOW)

    def test_explicit_version_must_advance(self):
        (self.state / "latest.json").write_text(json.dumps({"versionCode": 90, "file": "x.apk"}))
        with self.assertRaisesRegex(RuntimeError, "does not advance"):
            updates.release(build_number=90)
        self.assertEqual(self.shorebird(), [])
        self.assertFalse((self.state / "pending-release.json").exists())

    def test_release_fails_without_shorebird_and_never_builds_with_flutter(self):
        os.environ.pop("NATIVE_SHOREBIRD")
        os.environ["PATH"] = str(self.state / "empty")
        with self.assertRaisesRegex(RuntimeError, "Shorebird CLI not found"):
            updates.release()
        self.assertEqual(self.commands, [])

    def test_release_fails_without_the_public_key(self):
        self.public.unlink()
        with self.assertRaisesRegex(RuntimeError, "public key is missing"):
            updates.release()
        self.assertEqual(self.commands, [])

    def test_apk_with_another_app_id_is_not_published(self):
        self.embedded_app_id = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(RuntimeError, "different Shorebird app_id"):
            updates.release()
        self.assertIsNone(updates.latest())
        self.assertFalse((self.state / "baseline.json").exists())

    def test_apk_without_our_public_key_is_not_published(self):
        self.embedded_der = b"someone-elses-key"
        with self.assertRaisesRegex(RuntimeError, "does not carry"):
            updates.release()
        self.assertIsNone(updates.latest())

    def test_apk_with_another_signer_is_not_published(self):
        self.signer = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "signer differs"):
            updates.release()
        self.assertIsNone(updates.latest())
        self.assertFalse((self.state / "baseline.json").exists())

    def test_build_is_the_shorebird_release(self):
        updates.main(["build"])
        self.assertEqual(self.shorebird()[0][0][1:3], ["release", "android"])
        self.assertEqual(updates.latest()["versionCode"], NOW)


class PatchTest(ShorebirdHarness):
    def setUp(self):
        super().setUp()
        updates.release()
        self.commands.clear()
        self.key = self.state / "shorebird-private.pem"
        self.key.write_text("private\n")
        self.head = "b" * 40

    def test_patch_targets_the_baseline_release_on_staging_with_both_keys(self):
        (self.state / "latest.json").write_text(json.dumps({"versionCode": NOW + 9, "file": "later.apk"}))
        record = updates.patch()
        (args, kwargs), = self.shorebird()
        self.assertEqual(args, [
            str(self.cli), "patch", "android", f"--release-version=1.1.0+{NOW}", "--build-name=1.1.0",
            f"--build-number={NOW}", "--track=staging", f"--private-key-path={self.key}",
            f"--public-key-path={self.public}", "--", "--target-platform=android-arm64"])
        self.assertEqual(kwargs["cwd"], updates.NATIVE)
        self.assertEqual(kwargs["env"]["FROCKBOT_ANDROID_VERSION_FLOOR"], str(NOW - 1))
        self.assertEqual(record["track"], "staging")
        self.assertEqual(record["gitHead"], self.head)
        self.assertEqual(self.baseline()["patches"], [record])
        self.assertEqual(self.baseline()["buildNumber"], NOW)
        self.assertEqual(updates.latest()["versionCode"], NOW + 9)

    def test_patch_refuses_an_unresolved_release_before_calling_shorebird(self):
        (self.state / "pending-release.json").write_text(json.dumps({"releaseVersion": f"1.1.0+{NOW}"}))
        self.commands.clear()
        with self.assertRaisesRegex(RuntimeError, "Finish or reconcile it before uploading a patch"):
            updates.patch()
        self.assertEqual(self.commands, [])
        self.assertTrue((self.state / "pending-release.json").exists())
        self.assertEqual(self.baseline()["patches"], [])

    def test_patch_never_overrides_native_or_asset_diffs(self):
        updates.patch()
        (args, _), = self.shorebird()
        self.assertFalse(any("--allow-" in arg for arg in args))

    def test_patch_uses_the_private_key_from_the_environment(self):
        elsewhere = self.state / "elsewhere.pem"
        elsewhere.write_text("private\n")
        os.environ["NATIVE_SHOREBIRD_PRIVATE_KEY"] = str(elsewhere)
        updates.patch()
        self.assertIn(f"--private-key-path={elsewhere}", self.shorebird()[0][0])

    def test_patch_fails_without_the_private_key(self):
        self.key.unlink()
        with self.assertRaisesRegex(RuntimeError, "signing key is missing"):
            updates.patch()
        self.assertEqual(self.commands, [])

    def test_patch_fails_without_a_baseline(self):
        (self.state / "baseline.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "No Shorebird baseline"):
            updates.patch()
        self.assertEqual(self.commands, [])

    def test_mismatched_key_pair_is_rejected_before_upload(self):
        self.private_der = b"other-public-der"
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            updates.patch()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.baseline()["patches"], [])

    def test_changed_app_id_requires_a_new_release(self):
        self.yaml.write_text("app_id: 11111111-2222-3333-4444-555555555555\n")
        with self.assertRaisesRegex(RuntimeError, "app_id changed"):
            updates.patch()
        self.assertEqual(self.commands, [])

    def test_changed_public_key_requires_a_new_release(self):
        base = self.baseline()
        base["publicKeySha256"] = "0" * 64
        (self.state / "baseline.json").write_text(json.dumps(base))
        with self.assertRaisesRegex(RuntimeError, "public key changed"):
            updates.patch()
        self.assertEqual(self.commands, [])

    def test_changed_cli_or_flutter_requires_a_new_release(self):
        base = self.baseline()
        base["shorebirdCli"] = "1.6.119"
        (self.state / "baseline.json").write_text(json.dumps(base))
        with self.assertRaisesRegex(RuntimeError, "Shorebird CLI changed"):
            updates.patch()
        base["shorebirdCli"] = "1.6.120"
        base["flutterVersion"] = "3.46.0"
        (self.state / "baseline.json").write_text(json.dumps(base))
        with self.assertRaisesRegex(RuntimeError, "Flutter changed"):
            updates.patch()
        self.assertEqual(self.commands, [])

    def test_failed_patch_retains_intent_and_blocks_duplicate_upload(self):
        self.failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            updates.patch()
        self.assertEqual(self.baseline()["patches"], [])
        self.assertTrue((self.state / "pending-patch.json").exists())
        with self.assertRaisesRegex(RuntimeError, "unresolved"):
            updates.patch()
        self.assertEqual(len(self.shorebird()), 1)

    def test_track_override_and_lock_through_the_cli(self):
        updates.main(["patch", "--track", "stable"])
        self.assertIn("--track=stable", self.shorebird()[0][0])
        self.assertEqual(self.baseline()["patches"][0]["track"], "stable")


if __name__ == "__main__":
    unittest.main()

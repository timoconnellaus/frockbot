"""Signed Android delivery: Shorebird full releases, signed staging patches, same-signer APK downloads.

release: `shorebird release android` (Flutter 3.47.0, arm64 APK) with the patch public key baked
         in, the existing signer, a versionCode above every known floor. Saves the baseline and
         publishes the APK for download. `build` is the same command.
patch:   `shorebird patch android` against the baseline's exact version+build, staging track, signed
         with the private key. No new APK, no new versionCode, never native/asset overrides. The
         baseline is the saved release (`--baseline local`) or, in the release pipeline, the newest
         active Android release Shorebird reports (`--baseline shorebird`). Exit status 3 means
         Shorebird found native or asset differences: only a full release can carry that change.
promote: move a patch to the stable track.
publish: publish an already-built APK for download.  serve/setup: the download server.
export-apk: write the newest active Shorebird APK, re-signed with the phone's key.
         A tag whose patch exits 3 cuts `release` in the pipeline and uploads those
         bytes itself. `export-apk` is the sideload for every other tag.

The Shorebird CLI comes from NATIVE_SHOREBIRD or PATH. There is no stock Flutter fallback: a stock
build carries no patch key, so it could never be patched.
"""
import argparse
import base64
import fcntl
from functools import cache
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

from native_metadata import read_native_metadata

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get("NATIVE_UPDATE_STATE", ROOT / ".native-build/updates"))
NATIVE = ROOT / "apps/native"
PACKAGE = "com.frockbot.mobile"
SIGNER = "61e6479f9c5755154c1f939cde48e8a757eff3136e54ed1dda5f61e78b3c1e37"
FLUTTER_VERSION = "3.47.0"
TARGET_PLATFORM = "android-arm64"
PUBLIC_KEY = NATIVE / "shorebird-public-key.pem"
SHOREBIRD_YAML = NATIVE / "shorebird.yaml"
APK_OUTPUT = NATIVE / "build/app/outputs/flutter-apk/app-release.apk"
EMBEDDED_YAML = "assets/flutter_assets/shorebird.yaml"
VERSION_FLOOR_ENV = "FROCKBOT_ANDROID_VERSION_FLOOR"
# Gradle builds the production identity only for a build that asks for it here. A stock
# `flutter build apk` gets the isolated `.dev` app, so it can never replace the phone's
# patchable install with one the updater cannot reach.
RELEASE_IDENTITY_ENV = "FROCKBOT_ANDROID_RELEASE_IDENTITY"
FORBIDDEN_PATCH_FLAGS = ("--allow-native-diffs", "--allow-asset-diffs")
UNPATCHABLE_MESSAGES = ("Your app contains native changes", "Your app contains asset changes")
FULL_RELEASE_REQUIRED_STATUS = 3
INTENT_IDENTITY_KEYS = ("versionCode", "package", "appId", "buildName", "buildNumber", "releaseVersion",
                        "flutterVersion", "targetPlatform", "signerSha256", "publicKeySha256", "gitHead",
                        "workingTreeDirty", "intentCreatedAt")


@cache
def source_metadata():
    return read_native_metadata(ROOT)


def build_name():
    """The Android versionName: the version tag's `major.minor.patch`, or the placeholder outside a tag."""
    return source_metadata().version_name


def origin_define():
    """The deployment a hosted client talks to.

    The Dart client and the Android App Link both read it, and neither carries a host of
    its own: `deployments/hosted.json` is the one place the hosted origin is written, so a
    release and the patches that follow it cannot disagree about which server they reach.
    """
    return f"--dart-define=FROCKBOT_ORIGIN={source_metadata().hosted_origin}"


def release_defines():
    """The version tag `release.yml` builds, which the app shows and names in its hello.

    A patch is new Dart, so it names its own tag, while the release it patches keeps the versionName
    it was cut with: the running tag says which code booted. Gradle never reads the define, so it is
    no native change. A build cut by hand has no tag and passes none.
    """
    release = source_metadata().release
    return [f"--dart-define=FROCKBOT_RELEASE={release}"] if release else []


class FullReleaseRequired(RuntimeError):
    """Shorebird found native or asset differences, which no patch can carry."""


def run(args, *, binary=False, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=not binary, **kwargs)


def stream(args, **kwargs):
    """Run a long command, echoing its output as it arrives and keeping a copy to inspect."""
    args = [str(a) for a in args]
    lines = []
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kwargs) as process:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            lines.append(line)
    return process.returncode, "".join(lines)


def android_sdk():
    """The SDK whose build-tools inspect and re-sign an APK.

    An explicit `ANDROID_HOME` or `ANDROID_SDK_ROOT` wins. Otherwise use the
    `sdk.dir` the Flutter build wrote: a Shorebird release on a runner with no
    preinstalled SDK leaves `aapt` and `apksigner` there, and pointing
    `ANDROID_HOME` at a partial SDK beforehand would make that build fail.
    """
    explicit = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if explicit:
        return Path(explicit)
    local = NATIVE / "android" / "local.properties"
    if local.is_file():
        match = re.search(r"^sdk\.dir=(.*)$", local.read_text(), re.M)
        if match and match[1].strip():
            return Path(match[1].strip())
    return Path.home() / "Library/Android/sdk"


def build_tool(name):
    sdk = android_sdk()
    versions = [d for d in (sdk / "build-tools").glob("*") if (d / name).is_file()]
    if not versions:
        raise RuntimeError(f"No Android build-tools {name} under {sdk}. Install the Android SDK build-tools "
                           "or point ANDROID_HOME at an installation that has them.")
    newest = max(versions, key=lambda d: [int(part) if part.isdigit() else -1 for part in d.name.split(".")])
    return newest / name


def inspect_apk(apk):
    badging = run([build_tool("aapt"), "dump", "badging", apk])
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    if not match or match[1] != PACKAGE:
        raise RuntimeError("Only the normal FrockBot APK may be published here; Dev is a separate app.")
    cert = run([build_tool("apksigner"), "verify", "--print-certs", apk])
    # Build-tools 37 names the signer by scheme ("V3.0 Signer: certificate …"); earlier ones number it.
    signers = re.findall(r"Signer(?: #\d+|:) certificate SHA-256 digest: ([a-fA-F0-9]+)", cert)
    if [s.lower() for s in signers] != [SIGNER]:
        found = ", ".join(s.lower() for s in signers) or "(none)"
        raise RuntimeError(f"APK signer differs from the existing phone install "
                           f"(got {found}, expected {SIGNER}).")
    return {"package": PACKAGE, "versionCode": int(match[2]), "versionName": match[3],
            "signerSha256": SIGNER}


def latest():
    path = STATE / "latest.json"
    return json.loads(path.read_text()) if path.exists() else None


def write_atomic(path, text):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text)
    temporary.replace(path)


def publish(apk, floor=0):
    metadata = inspect_apk(apk)
    previous = latest()
    if metadata["versionCode"] <= max(floor, previous["versionCode"] if previous else 0):
        raise RuntimeError("Refusing to publish a version that does not advance the upgrade track.")
    with apk.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    filename = f"frockbot-{metadata['versionCode']}-{digest}.apk"
    temporary = STATE / "upload.tmp"
    shutil.copyfile(apk, temporary)
    temporary.replace(STATE / filename)
    metadata.update(sha256=digest, file=filename, bytes=apk.stat().st_size,
                    publishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    gitHead=run(["git", "rev-parse", "HEAD"], cwd=ROOT).strip(),
                    workingTreeDirty=bool(run(["git", "status", "--porcelain"], cwd=ROOT).strip()))
    # Readers see either the previous complete release or this complete release.
    write_atomic(STATE / "latest.json", json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))
    return metadata


def shorebird_cli():
    explicit = os.environ.get("NATIVE_SHOREBIRD")
    if explicit:
        if not Path(explicit).is_file():
            raise RuntimeError(f"NATIVE_SHOREBIRD points at a missing file: {explicit}")
        return explicit
    found = shutil.which("shorebird")
    if not found:
        raise RuntimeError("Shorebird CLI not found. Set NATIVE_SHOREBIRD or add `shorebird` to PATH. "
                           "A stock `flutter build` is not a substitute: it cannot carry the patch key.")
    return found


def cli_version(cli):
    match = re.search(r"Shorebird (\S+)", run([cli, "--version"], stderr=subprocess.STDOUT))
    if not match:
        raise RuntimeError("Could not read the Shorebird CLI version.")
    return match[1]


def private_key():
    path = Path(os.environ.get("NATIVE_SHOREBIRD_PRIVATE_KEY", STATE / "shorebird-private.pem"))
    if not path.is_file():
        raise RuntimeError(f"Patch signing key is missing: {path}. Set NATIVE_SHOREBIRD_PRIVATE_KEY or "
                           "place it under the ignored state directory. Never commit it.")
    return path


def public_key_der():
    if not PUBLIC_KEY.is_file():
        raise RuntimeError(f"Patch public key is missing: {PUBLIC_KEY}")
    return run(["openssl", "rsa", "-pubin", "-in", PUBLIC_KEY, "-RSAPublicKey_out", "-outform", "DER"],
               binary=True, stderr=subprocess.DEVNULL)


def private_key_public_der(key):
    # Emits only the public half; the private material never leaves openssl.
    return run(["openssl", "rsa", "-in", key, "-RSAPublicKey_out", "-outform", "DER"],
               binary=True, stderr=subprocess.DEVNULL)


def yaml_value(text, key):
    match = re.search(rf"^{key}:\s*(\S+)", text, re.M)
    return match[1].strip("'\"") if match else None


def app_id():
    value = yaml_value(SHOREBIRD_YAML.read_text(), "app_id")
    if not value:
        raise RuntimeError(f"No app_id in {SHOREBIRD_YAML}")
    return value


def inspect_release(apk, der):
    # The updater trusts only what is inside the APK: the app it belongs to and the key it verifies with.
    with zipfile.ZipFile(apk) as archive:
        embedded = archive.read(EMBEDDED_YAML).decode()
    if yaml_value(embedded, "app_id") != app_id():
        raise RuntimeError("The built APK carries a different Shorebird app_id than apps/native/shorebird.yaml.")
    encoded = yaml_value(embedded, "patch_public_key")
    if not encoded or base64.b64decode(encoded) != der:
        raise RuntimeError("The built APK does not carry apps/native/shorebird-public-key.pem; patches could "
                           "never verify. Not publishing.")


def baseline():
    path = STATE / "baseline.json"
    if not path.exists():
        raise RuntimeError(f"No Shorebird baseline at {path}. Run `release` first; a patch needs a release.")
    return json.loads(path.read_text())


def shorebird_json(cli, args):
    document = json.loads(run([cli, *args, "--json"], cwd=NATIVE))
    if document.get("status") != "success":
        raise RuntimeError(f"`shorebird {' '.join(args)}` failed: {document.get('error') or document}")
    return document["data"]


def release_code(release):
    return int(release["version"].split("+", 1)[1])


def service_baseline(cli):
    """The newest active Android release Shorebird has for this app, in the shape `baseline.json` uses.

    The pipeline has no state directory. The release it last cut — the patch baseline, or a full
    release when a patch could not carry the diff — is the newest active one. What the service
    cannot say is which public key that release carries, so the key-pair check below is the only
    key check here.
    """
    expected = app_id()
    releases = [release for release in shorebird_json(cli, ["releases", "list"])["releases"]
                if release["app_id"] == expected and release.get("platform_statuses", {}).get("android") == "active"]
    if not releases:
        raise RuntimeError(f"Shorebird has no active Android release for app {expected}. Run `release` first.")
    newest = max(releases, key=release_code)
    name, code = newest["version"].split("+", 1)
    return {"package": PACKAGE, "appId": newest["app_id"], "buildName": name, "buildNumber": int(code),
            "releaseVersion": newest["version"], "flutterVersion": newest["flutter_version"],
            "targetPlatform": TARGET_PLATFORM, "patches": []}


def keystore_path():
    path = Path(os.environ.get("FROCKBOT_ANDROID_KEYSTORE", Path.home() / ".android" / "debug.keystore"))
    if not path.is_file():
        raise RuntimeError(f"Existing Android signing key is missing: {path}. Set FROCKBOT_ANDROID_KEYSTORE. "
                           "Never generate a replacement.")
    return path


def choose_exported_apk(directory):
    """The one APK Shorebird produced for sideload.

    `get-apks` prefers a universal APK. An arm64-only release has no universal
    file and one split whose name contains `arm64`, which is the phone's ABI.
    """
    apks = [path for path in directory.rglob("*.apk") if path.is_file()]
    universal = [path for path in apks if path.name == "universal.apk"]
    if len(universal) == 1:
        return universal[0]
    arm64 = [path for path in apks if "arm64" in path.name]
    if len(arm64) == 1:
        return arm64[0]
    if len(apks) == 1:
        return apks[0]
    names = ", ".join(sorted(path.name for path in apks)) or "(none)"
    raise RuntimeError(f"Shorebird did not produce one APK to publish ({names}).")


def sign_apk(apk, keystore):
    """Replace bundletool's debug signature with the key the phone already trusts.

    `shorebird releases get-apks` builds from the stored app bundle and signs
    with bundletool's own key. Android would refuse that as an upgrade, and the
    install would leave the patch channel.
    """
    aligned = apk.with_name(f"{apk.stem}.aligned.apk")
    run([build_tool("zipalign"), "-f", "-p", "4", apk, aligned])
    aligned.replace(apk)
    run([build_tool("apksigner"), "sign", "--ks", keystore, "--ks-pass", "pass:android",
         "--key-pass", "pass:android", "--ks-key-alias", "androiddebugkey", apk])


def export_apk(destination):
    """Write the newest active Shorebird release's APK to `destination`.

    The bytes are that release. A tag that had to cut a full release uploads
    the APK that release just built; this path is the sideload for a tag that
    patched, or left the client unchanged.
    """
    keystore = keystore_path()
    cli = shorebird_cli()
    base = service_baseline(cli)
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory)
        subprocess.run([cli, "releases", "get-apks", f"--release-version={base['releaseVersion']}",
                        "--out", str(out)], cwd=NATIVE, check=True)
        apk = choose_exported_apk(out)
        sign_apk(apk, keystore)
        inspect_release(apk, public_key_der())
        inspected = inspect_apk(apk)
        if inspected["versionCode"] != base["buildNumber"] or inspected["versionName"] != base["buildName"]:
            raise RuntimeError(f"Exported {inspected['versionName']}+{inspected['versionCode']}, "
                               f"expected {base['releaseVersion']}.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(apk, destination)
    print(json.dumps({"release": base["releaseVersion"], "file": str(destination)}, indent=2))


def patch_number(cli, release_version):
    patches = shorebird_json(cli, ["patches", "list", f"--release-version={release_version}"])["patches"]
    return max((entry["number"] for entry in patches), default=None)


def source():
    return {"gitHead": run(["git", "rev-parse", "HEAD"], cwd=ROOT).strip(),
            "workingTreeDirty": bool(run(["git", "status", "--porcelain"], cwd=ROOT).strip())}


def release_record(intent, metadata):
    return {
        **intent,
        "file": metadata["file"], "apkSha256": metadata["sha256"],
        "createdAt": metadata["publishedAt"], "patches": [],
    }


def load_pending_intent(path):
    intent = json.loads(path.read_text())
    missing = [key for key in INTENT_IDENTITY_KEYS if key not in intent]
    if missing:
        raise RuntimeError(f"{path} predates full release-identity recording (missing {', '.join(missing)}); a "
                           "release cannot be recovered from it. Check `shorebird releases list`, then delete it "
                           "once you know whether that release uploaded.")
    return intent


def recover_published_release(intent, metadata, current_source, der):
    expected = {
        "package": PACKAGE, "appId": app_id(), "buildName": build_name(),
        "buildNumber": intent["versionCode"], "releaseVersion": f"{build_name()}+{intent['versionCode']}",
        "flutterVersion": FLUTTER_VERSION, "targetPlatform": TARGET_PLATFORM,
        "signerSha256": SIGNER,
        "publicKeySha256": hashlib.sha256(der).hexdigest(), **current_source,
    }
    mismatches = [name for name, value in expected.items() if intent.get(name) != value]
    if mismatches:
        raise RuntimeError(f"Pending release identity differs from the current release: {', '.join(mismatches)}.")
    apk = STATE / metadata.get("file", "")
    if not apk.is_file():
        raise RuntimeError("Pending release matches latest.json, but its published APK is missing.")
    inspect_release(apk, der)
    inspected = inspect_apk(apk)
    if inspected["versionCode"] != intent["buildNumber"] or inspected["versionName"] != intent["buildName"]:
        raise RuntimeError("Published APK version differs from its pending release identity.")
    with apk.open("rb") as source_file:
        digest = hashlib.file_digest(source_file, "sha256").hexdigest()
    published_expected = {
        **inspected, "sha256": digest, "bytes": apk.stat().st_size,
        "file": f"frockbot-{inspected['versionCode']}-{digest}.apk", **current_source,
    }
    mismatches = [name for name, value in published_expected.items() if metadata.get(name) != value]
    if mismatches:
        raise RuntimeError(f"Published release identity differs from its pending intent: {', '.join(mismatches)}.")
    record = release_record(intent, metadata)
    record.pop("versionCode")
    write_atomic(STATE / "baseline.json", json.dumps(record, indent=2) + "\n")
    return record


def release(floor=0, build_number=None):
    current_source = source()
    if current_source["workingTreeDirty"]:
        raise RuntimeError("Commit the reviewed changes before uploading a release.")
    cli = shorebird_cli()
    version_cli = cli_version(cli)
    der = public_key_der()
    previous = latest()
    floor = max(floor, previous["versionCode"] if previous else 0)
    pending = STATE / "pending-release.json"
    intent = load_pending_intent(pending) if pending.exists() else None
    if intent:
        if intent["gitHead"] != current_source["gitHead"]:
            raise RuntimeError("The pending release belongs to another commit; reconcile it before uploading.")
        # An earlier upload may have reached Shorebird. Only that exact version is retried.
        if build_number not in (None, intent["versionCode"]):
            raise RuntimeError(f"Release {intent['releaseVersion']} is pending from {intent['intentCreatedAt']}. "
                               f"Retry with --build-number {intent['versionCode']}, or check `shorebird releases "
                               f"list` and delete {pending} once you know it never uploaded.")
        version = intent["versionCode"]
    else:
        version = build_number or max(int(time.time()), floor + 1)
    if intent and previous and previous.get("versionCode") == version:
        record = recover_published_release(intent, previous, current_source, der)
        pending.unlink()
        return record
    if version <= floor:
        raise RuntimeError(f"versionCode {version} does not advance past the floor {floor}.")
    if version > 2100000000:
        raise RuntimeError("Android versionCode limit reached.")
    args = [cli, "release", "android", f"--flutter-version={FLUTTER_VERSION}", "--artifact=apk",
            f"--target-platform={TARGET_PLATFORM}", f"--build-name={build_name()}", f"--build-number={version}",
            f"--public-key-path={PUBLIC_KEY}", "--", origin_define(), *release_defines()]
    if not intent:
        intent = {
            "versionCode": version, "package": PACKAGE, "appId": app_id(), "buildName": build_name(),
            "buildNumber": version, "releaseVersion": f"{build_name()}+{version}", "versionFloor": floor,
            "flutterVersion": FLUTTER_VERSION, "targetPlatform": TARGET_PLATFORM, "shorebirdCli": version_cli,
            "signerSha256": SIGNER, "publicKeyPath": str(PUBLIC_KEY),
            "publicKeySha256": hashlib.sha256(der).hexdigest(), "releaseArgs": args[1:],
            "intentCreatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **current_source,
        }
        write_atomic(pending, json.dumps(intent, indent=2) + "\n")
    env = {**os.environ, VERSION_FLOOR_ENV: str(floor), RELEASE_IDENTITY_ENV: "true"}
    subprocess.run(args, cwd=NATIVE, env=env, check=True)
    # Shorebird's release build may leave the APK under a key the phone does not
    # trust. Re-sign with the existing install's keystore before publishing, the
    # same way `export-apk` does for a downloaded release.
    sign_apk(APK_OUTPUT, keystore_path())
    inspect_release(APK_OUTPUT, der)
    metadata = inspect_apk(APK_OUTPUT)
    if metadata["versionCode"] != version or metadata["versionName"] != build_name():
        raise RuntimeError(f"Built {metadata['versionName']}+{metadata['versionCode']}, expected {build_name()}+{version}.")
    metadata = publish(APK_OUTPUT, floor)
    # A retry may run a different CLI or checkout than the intent recorded; the build just made these true.
    built_with = {"shorebirdCli": version_cli, "publicKeyPath": str(PUBLIC_KEY), "releaseArgs": args[1:],
                  "versionFloor": floor, "publicKeySha256": hashlib.sha256(der).hexdigest()}
    record = release_record({**intent, **built_with}, metadata)
    record.pop("versionCode")
    write_atomic(STATE / "baseline.json", json.dumps(record, indent=2) + "\n")
    pending.unlink()
    return record


def patch(track="staging", baseline_source="local", result=None):
    pending_release = STATE / "pending-release.json"
    if pending_release.exists():
        raise RuntimeError(f"A release is still pending. Finish or reconcile it before uploading a patch: {pending_release}")
    current_source = source()
    if current_source["workingTreeDirty"]:
        raise RuntimeError("Commit the reviewed changes before uploading a patch.")
    pending = STATE / "pending-patch.json"
    if pending.exists():
        raise RuntimeError(f"A previous patch upload is unresolved. Check Shorebird before removing {pending}; do not upload it twice.")
    cli = shorebird_cli()
    local = baseline_source == "local"
    base = baseline() if local else service_baseline(cli)
    key = private_key()
    der = public_key_der()
    checks = {
        "package": (base["package"], PACKAGE),
        "app_id": (base["appId"], app_id()),
        "Flutter": (base["flutterVersion"], FLUTTER_VERSION),
    }
    if local:
        checks.update({
            "public key": (base["publicKeySha256"], hashlib.sha256(der).hexdigest()),
            "Shorebird CLI": (base["shorebirdCli"], cli_version(cli)),
        })
    for name, (recorded, current) in checks.items():
        if recorded != current:
            raise RuntimeError(f"The {name} changed since release {base['releaseVersion']} ({recorded} -> {current}). "
                               "A patch cannot follow; cut a new full release.")
    if private_key_public_der(key) != der:
        raise RuntimeError(f"{key} does not match {PUBLIC_KEY}; a patch signed with it would never install.")
    args = [cli, "patch", "android", f"--release-version={base['releaseVersion']}",
            f"--build-name={base['buildName']}", f"--build-number={base['buildNumber']}", f"--track={track}",
            f"--private-key-path={key}", f"--public-key-path={PUBLIC_KEY}",
            "--", f"--target-platform={base['targetPlatform']}", origin_define(), *release_defines()]
    if any(flag in arg for arg in args for flag in FORBIDDEN_PATCH_FLAGS):
        raise RuntimeError("A patch never overrides native or asset diffs; ship a full release instead.")
    # The release was built one above its floor; the same floor makes Gradle emit the same versionCode.
    env = {**os.environ, VERSION_FLOOR_ENV: str(base["buildNumber"] - 1), RELEASE_IDENTITY_ENV: "true"}
    write_atomic(pending, json.dumps({"releaseVersion": base["releaseVersion"], "track": track, **current_source}, indent=2) + "\n")
    status, output = stream(args, cwd=NATIVE, env=env)
    if status != 0:
        if any(message in output for message in UNPATCHABLE_MESSAGES):
            # The CLI stops before uploading anything, so there is no upload to reconcile.
            pending.unlink()
            raise FullReleaseRequired(f"Shorebird found changes a patch cannot carry against {base['releaseVersion']}. "
                                      "A full release carries them.")
        raise subprocess.CalledProcessError(status, args)
    record = {"track": track, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "number": patch_number(cli, base["releaseVersion"]), "patchArgs": args[1:], **source()}
    if local:
        base["patches"].append(record)
        write_atomic(STATE / "baseline.json", json.dumps(base, indent=2) + "\n")
    pending.unlink()
    summary = {"release": base["releaseVersion"], "patch": record}
    if result:
        write_atomic(result, json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return record


def promote(release_version, number):
    cli = shorebird_cli()
    subprocess.run([cli, "patches", "promote", f"--release-version={release_version}", f"--patch-number={number}"],
                   cwd=NATIVE, check=True)
    path = STATE / "baseline.json"
    if path.exists():
        base = json.loads(path.read_text())
        if base.get("releaseVersion") == release_version:
            for entry in base["patches"]:
                if entry.get("number") == number:
                    entry["track"] = "stable"
            write_atomic(path, json.dumps(base, indent=2) + "\n")
    print(json.dumps({"release": release_version, "patch": number, "track": "stable"}, indent=2))


class Downloads(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.respond(False)

    def do_GET(self):
        self.respond(True)

    def respond(self, body):
        route = self.path.split("?", 1)[0]
        if route not in ("/frockbot.apk", "/latest.json", "/health"):
            self.send_error(404)
            return
        if route == "/health":
            data = b"ok\n"
        else:
            metadata = latest()
            if not metadata:
                self.send_error(503, "No APK published yet")
                return
            if route == "/frockbot.apk":
                path = STATE / metadata["file"]
                if not path.is_file():
                    self.send_error(503, "No APK published yet")
                    return
                with path.open("rb") as apk:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/vnd.android.package-archive")
                    self.send_header("Content-Length", str(os.fstat(apk.fileno()).st_size))
                    self.send_header("Content-Disposition", f'attachment; filename="frockbot-{metadata["versionCode"]}.apk"')
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if body:
                        shutil.copyfileobj(apk, self.wfile)
                return
            data = json.dumps(metadata).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if route == "/latest.json" else "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(data)


def setup():
    tailscale = shutil.which("tailscale")
    if not tailscale:
        raise RuntimeError("Install and connect Tailscale first.")
    status = json.loads(run([tailscale, "status", "--json"]))
    if status.get("BackendState") != "Running":
        raise RuntimeError("Connect Tailscale first.")
    hostname = status["Self"]["DNSName"].rstrip(".")
    endpoint = f"{hostname}:8443"
    config = json.loads(run([tailscale, "serve", "status", "--json"]))
    target = "http://127.0.0.1:18743"
    existing = config.get("Web", {}).get(endpoint)
    if existing and existing != {"Handlers": {"/": {"Proxy": target}}}:
        raise RuntimeError("Tailscale port 8443 is already used by another service.")
    if config.get("AllowFunnel", {}).get(endpoint):
        raise RuntimeError("Port 8443 has public Funnel enabled; refusing to expose this APK publicly.")
    tcp = config.get("TCP", {}).get("8443")
    if tcp and tcp != {"HTTPS": True}:
        raise RuntimeError("Tailscale TCP port 8443 is already used by another service.")
    label = "com.frockbot.android-updates"
    plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    settings = {
        "Label": label,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "serve"],
        "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": True,
        "StandardOutPath": str(STATE / "server.log"),
        "StandardErrorPath": str(STATE / "server.log"),
    }
    if plist.exists() and plistlib.loads(plist.read_bytes()).get("ProgramArguments") != settings["ProgramArguments"]:
        raise RuntimeError(f"Existing {plist} points to another checkout; refusing to replace it.")
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_bytes(plistlib.dumps(settings))
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    subprocess.run([tailscale, "serve", "--bg", "--yes", "--https=8443", target], check=True)
    print(f"Bookmark https://{endpoint}/frockbot.apk on your phone.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["build", "release", "patch", "promote", "publish", "serve", "setup",
                                            "export-apk"])
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--out", type=Path, help="export-apk: where to write frockbot.apk.")
    parser.add_argument("--baseline", default="local", choices=["local", "shorebird"],
                        help="Patch the saved release (local) or the newest active release Shorebird reports.")
    parser.add_argument("--result", type=Path, help="Write the patch outcome as JSON here as well as printing it.")
    parser.add_argument("--release-version", help="promote: the release the patch belongs to, e.g. 1.2.0+1789034833.")
    parser.add_argument("--patch-number", type=int, help="promote: the patch number to move to stable.")
    parser.add_argument("--version-floor", type=int, default=0,
                        help="Optional known installed versionCode; publishing does not require ADB.")
    parser.add_argument("--build-number", type=int, help="Exact versionCode, to retry one uncertain release upload.")
    parser.add_argument("--track", default="staging", choices=["staging", "beta", "stable"])
    args = parser.parse_args(argv)
    STATE.mkdir(parents=True, exist_ok=True)
    if args.command == "export-apk":
        if args.out is None:
            parser.error("export-apk requires --out")
        export_apk(args.out)
        return
    if args.command == "setup":
        setup()
        return
    if args.command == "serve":
        ThreadingHTTPServer(("127.0.0.1", 18743), Downloads).serve_forever()
        return
    with (STATE / "publish.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another Android release, patch, or publication is already running.") from error
        if args.command in ("build", "release"):
            release(args.version_floor, args.build_number)
        elif args.command == "patch":
            try:
                patch(args.track, args.baseline, args.result)
            except FullReleaseRequired as error:
                print(error, file=sys.stderr)
                sys.exit(FULL_RELEASE_REQUIRED_STATUS)
        elif args.command == "promote":
            if not args.release_version or args.patch_number is None:
                parser.error("promote requires --release-version and --patch-number")
            promote(args.release_version, args.patch_number)
        else:
            if not args.apk:
                parser.error("publish requires --apk")
            publish(args.apk.resolve(), args.version_floor)


if __name__ == "__main__":
    main()

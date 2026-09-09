"""Signed Android delivery: Shorebird full releases, signed staging patches, same-signer APK downloads.

release: `shorebird release android` (Flutter 3.47.0, arm64 APK) with the patch public key baked
         in, the existing signer, a versionCode above every known floor. Saves the baseline and
         publishes the APK for download. `build` is the same command.
patch:   `shorebird patch android` against the saved baseline's exact version+build, staging track,
         signed with the private key. No new APK, no new versionCode, never native/asset overrides.
publish: publish an already-built APK for download.  serve/setup: the download server.

The Shorebird CLI comes from NATIVE_SHOREBIRD or PATH. There is no stock Flutter fallback: a stock
build carries no patch key, so it could never be patched.
"""
import argparse
import base64
import fcntl
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
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get("NATIVE_UPDATE_STATE", ROOT / ".native-build/updates"))
NATIVE = ROOT / "apps/native"
PACKAGE = "com.frockbot.mobile"
SIGNER = "61e6479f9c5755154c1f939cde48e8a757eff3136e54ed1dda5f61e78b3c1e37"
BUILD_NAME = "1.1.0"
FLUTTER_VERSION = "3.47.0"
TARGET_PLATFORM = "android-arm64"
PUBLIC_KEY = NATIVE / "shorebird-public-key.pem"
SHOREBIRD_YAML = NATIVE / "shorebird.yaml"
APK_OUTPUT = NATIVE / "build/app/outputs/flutter-apk/app-release.apk"
EMBEDDED_YAML = "assets/flutter_assets/shorebird.yaml"
VERSION_FLOOR_ENV = "FROCKBOT_ANDROID_VERSION_FLOOR"
FORBIDDEN_PATCH_FLAGS = ("--allow-native-diffs", "--allow-asset-diffs")


def run(args, *, binary=False, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=not binary, **kwargs)


def build_tool(name):
    sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
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
    signers = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", cert)
    if [s.lower() for s in signers] != [SIGNER]:
        raise RuntimeError("APK signer differs from the existing phone install.")
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


def source():
    return {"gitHead": run(["git", "rev-parse", "HEAD"], cwd=ROOT).strip(),
            "workingTreeDirty": bool(run(["git", "status", "--porcelain"], cwd=ROOT).strip())}


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
    intent = json.loads(pending.read_text()) if pending.exists() else None
    if intent:
        if intent["gitHead"] != current_source["gitHead"]:
            raise RuntimeError("The pending release belongs to another commit; reconcile it before uploading.")
        # An earlier upload may have reached Shorebird. Only that exact version is retried.
        if build_number not in (None, intent["versionCode"]):
            raise RuntimeError(f"Release {intent['releaseVersion']} is pending from {intent['createdAt']}. "
                               f"Retry with --build-number {intent['versionCode']}, or check `shorebird releases "
                               f"list` and delete {pending} once you know it never uploaded.")
        version = intent["versionCode"]
    else:
        version = build_number or max(int(time.time()), floor + 1)
    if version <= floor:
        raise RuntimeError(f"versionCode {version} does not advance past the floor {floor}.")
    if version > 2100000000:
        raise RuntimeError("Android versionCode limit reached.")
    args = [cli, "release", "android", f"--flutter-version={FLUTTER_VERSION}", "--artifact=apk",
            f"--target-platform={TARGET_PLATFORM}", f"--build-name={BUILD_NAME}", f"--build-number={version}",
            f"--public-key-path={PUBLIC_KEY}"]
    if not intent:
        write_atomic(pending, json.dumps({"versionCode": version, "releaseVersion": f"{BUILD_NAME}+{version}",
                                          "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                          **source()}, indent=2) + "\n")
    env = {**os.environ, VERSION_FLOOR_ENV: str(floor)}
    subprocess.run(args, cwd=NATIVE, env=env, check=True)
    inspect_release(APK_OUTPUT, der)
    metadata = inspect_apk(APK_OUTPUT)
    if metadata["versionCode"] != version or metadata["versionName"] != BUILD_NAME:
        raise RuntimeError(f"Built {metadata['versionName']}+{metadata['versionCode']}, expected {BUILD_NAME}+{version}.")
    metadata = publish(APK_OUTPUT, floor)
    record = {
        "package": PACKAGE, "appId": app_id(), "buildName": BUILD_NAME, "buildNumber": version,
        "releaseVersion": f"{BUILD_NAME}+{version}", "versionFloor": floor,
        "flutterVersion": FLUTTER_VERSION, "targetPlatform": TARGET_PLATFORM, "shorebirdCli": version_cli,
        "signerSha256": SIGNER, "publicKeyPath": str(PUBLIC_KEY), "publicKeySha256": hashlib.sha256(der).hexdigest(),
        "file": metadata["file"], "apkSha256": metadata["sha256"], "gitHead": metadata["gitHead"],
        "workingTreeDirty": metadata["workingTreeDirty"], "releaseArgs": args[1:],
        "createdAt": metadata["publishedAt"], "patches": [],
    }
    write_atomic(STATE / "baseline.json", json.dumps(record, indent=2) + "\n")
    pending.unlink()
    return record


def patch(track="staging"):
    current_source = source()
    if current_source["workingTreeDirty"]:
        raise RuntimeError("Commit the reviewed changes before uploading a patch.")
    pending = STATE / "pending-patch.json"
    if pending.exists():
        raise RuntimeError(f"A previous patch upload is unresolved. Check Shorebird before removing {pending}; do not upload it twice.")
    cli = shorebird_cli()
    base = baseline()
    key = private_key()
    der = public_key_der()
    checks = {
        "package": (base["package"], PACKAGE),
        "app_id": (base["appId"], app_id()),
        "public key": (base["publicKeySha256"], hashlib.sha256(der).hexdigest()),
        "Shorebird CLI": (base["shorebirdCli"], cli_version(cli)),
        "Flutter": (base["flutterVersion"], FLUTTER_VERSION),
    }
    for name, (recorded, current) in checks.items():
        if recorded != current:
            raise RuntimeError(f"The {name} changed since release {base['releaseVersion']} ({recorded} -> {current}). "
                               "A patch cannot follow; cut a new full release.")
    if private_key_public_der(key) != der:
        raise RuntimeError(f"{key} does not match {PUBLIC_KEY}; a patch signed with it would never install.")
    args = [cli, "patch", "android", f"--release-version={base['releaseVersion']}",
            f"--build-name={base['buildName']}", f"--build-number={base['buildNumber']}", f"--track={track}",
            f"--private-key-path={key}", f"--public-key-path={PUBLIC_KEY}",
            "--", f"--target-platform={base['targetPlatform']}"]
    if any(flag in arg for arg in args for flag in FORBIDDEN_PATCH_FLAGS):
        raise RuntimeError("A patch never overrides native or asset diffs; ship a full release instead.")
    # The release was built one above its floor; the same floor makes Gradle emit the same versionCode.
    env = {**os.environ, VERSION_FLOOR_ENV: str(base["buildNumber"] - 1)}
    write_atomic(pending, json.dumps({"releaseVersion": base["releaseVersion"], "track": track, **current_source}, indent=2) + "\n")
    subprocess.run(args, cwd=NATIVE, check=True, env=env)
    record = {"track": track, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "patchArgs": args[1:], **source()}
    base["patches"].append(record)
    write_atomic(STATE / "baseline.json", json.dumps(base, indent=2) + "\n")
    pending.unlink()
    print(json.dumps({"release": base["releaseVersion"], "patch": record}, indent=2))
    return record


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
    parser.add_argument("command", choices=["build", "release", "patch", "publish", "serve", "setup"])
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--version-floor", type=int, default=0,
                        help="Optional known installed versionCode; publishing does not require ADB.")
    parser.add_argument("--build-number", type=int, help="Exact versionCode, to retry one uncertain release upload.")
    parser.add_argument("--track", default="staging", choices=["staging", "beta", "stable"])
    args = parser.parse_args(argv)
    STATE.mkdir(parents=True, exist_ok=True)
    if args.command == "setup":
        setup()
        return
    if args.command == "serve":
        ThreadingHTTPServer(("127.0.0.1", 18743), Downloads).serve_forever()
        return
    with (STATE / "publish.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command in ("build", "release"):
            release(args.version_floor, args.build_number)
        elif args.command == "patch":
            patch(args.track)
        else:
            if not args.apk:
                parser.error("publish requires --apk")
            publish(args.apk.resolve(), args.version_floor)


if __name__ == "__main__":
    main()

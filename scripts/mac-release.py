#!/usr/bin/env python3
"""Build the main FrockBot Mac app; publishing requires Developer ID + notarization."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "apps/mac-messages"
NATIVE = ROOT / "apps/native"


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=NATIVE if str(args[0]) == "flutter" else ROOT, check=True)


def notarize(target, profile):
    result = subprocess.run(["xcrun", "notarytool", "submit", str(target),
        "--keychain-profile", profile, "--wait", "--output-format", "json"],
        check=True, capture_output=True, text=True)
    report = json.loads(result.stdout)
    if report.get("status") != "Accepted":
        raise RuntimeError(f"Notarization was not accepted (submission {report.get('id', 'unknown')})")
    run("xcrun", "stapler", "staple", target)
    run("xcrun", "stapler", "validate", target)


def build(version, destination, identity=None, profile=None, provisioning=None):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Version must be major.minor.patch")
    if (identity is None) != (profile is None):
        raise ValueError("Both Developer ID identity and notarytool profile are required")
    if identity and not identity.startswith("Developer ID Application:"):
        raise ValueError("Direct distribution requires a Developer ID Application identity")
    if identity and not provisioning:
        raise ValueError("A Developer ID provisioning profile for associated-domain sign-in is required")
    destination.mkdir(parents=True, exist_ok=True)
    # Never package stale files or overwrite a previously produced release.
    with tempfile.TemporaryDirectory(prefix="frockbot-mac-") as temporary:
        staging = Path(temporary)
        run("flutter", "build", "macos", "--release", "--no-pub", "--config-only", "--build-name", version)
        run("xcodebuild", "-workspace", NATIVE / "macos/Runner.xcworkspace", "-scheme", "Runner",
            "-configuration", "Release", "-derivedDataPath", staging / "build", "CODE_SIGNING_ALLOWED=NO",
            "ARCHS=arm64 x86_64", "ONLY_ACTIVE_ARCH=NO", "build")
        app = staging / "build/Build/Products/Release/FrockBot.app"
        contents = app / "Contents"
        (contents / "Helpers").mkdir(exist_ok=True)
        helper = contents / "Helpers/messages-agent"
        parts = []
        for arch in ["arm64", "x64"]:
            part = staging / f"agent-{arch}"
            run("bun", "build", "--compile", f"--target=bun-darwin-{arch}", SOURCE / "agent.ts", "--outfile", part)
            parts.append(part)
        run("lipo", "-create", *parts, "-output", helper)
        app_entitlements = plistlib.loads((NATIVE / "macos/Runner/Release.entitlements").read_bytes())
        if identity:
            decoded = subprocess.run(["security", "cms", "-D", "-i", str(provisioning)], check=True, capture_output=True)
            entitlements = plistlib.loads(decoded.stdout)["Entitlements"]
            app_id = entitlements.get("com.apple.application-identifier", "")
            if not app_id.endswith(".com.frockbot.mobile"):
                raise ValueError("Provisioning profile does not name com.frockbot.mobile")
            domains = entitlements.get("com.apple.developer.associated-domains", [])
            if "applinks:bot.frockbot.com" not in domains and "*" not in domains:
                raise ValueError("Provisioning profile does not permit the FrockBot sign-in domain")
            for key in ["com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]:
                if key in entitlements: app_entitlements[key] = entitlements[key]
            (contents / "embedded.provisionprofile").write_bytes(Path(provisioning).read_bytes())
        else:
            # A development build cannot claim verified associated domains without a profile.
            app_entitlements.pop("com.apple.developer.associated-domains", None)
            app_entitlements.pop("keychain-access-groups", None)
        entitlement_file = staging / "App.entitlements"
        entitlement_file.write_bytes(plistlib.dumps(app_entitlements))
        # Sign nested frameworks inside-out; the app's permissions belong only to the app.
        frameworks = contents / "Frameworks"
        nested = sorted([*frameworks.rglob("*.dylib"), *frameworks.rglob("*.framework")], key=lambda p: len(p.parts), reverse=True)
        for item in nested:
            args = ["codesign", "--force", "--sign", identity or "-", "--options", "runtime"]
            if identity: args.append("--timestamp")
            run(*args, item)
        for item, entitlements in [(helper, SOURCE / "Agent.entitlements"), (app, entitlement_file)]:
            args = ["codesign", "--force", "--sign", identity or "-", "--options", "runtime",
                    "--entitlements", entitlements]
            if identity:
                args.append("--timestamp")
            run(*args, item)
        run("codesign", "--verify", "--deep", "--strict", app)
        if identity:
            # Notarize and staple the app first so the copy inside the image
            # carries its own ticket, then package, sign, notarize and staple
            # the disk image that is the public download.
            submission = staging / "submission.zip"
            run("ditto", "-c", "-k", "--keepParent", app, submission)
            notarize(submission, profile)
            run("xcrun", "stapler", "staple", app)
            run("xcrun", "stapler", "validate", app)
            run("spctl", "--assess", "--type", "execute", "--verbose=2", app)
            archive = destination / "FrockBot-macos.dmg"
        else:
            archive = destination / "FrockBot-macos-development.zip"
        if archive.exists():
            raise FileExistsError(f"Refusing to replace {archive}")
        packaged = staging / archive.name
        if identity:
            run(ROOT / "scripts/mac-dmg.sh", app, packaged, identity)
            notarize(packaged, profile)
            run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", packaged)
        else:
            run("ditto", "-c", "-k", "--keepParent", app, packaged)
        # Reserve the destination atomically; a failed copy never looks like a release.
        with packaged.open("rb") as source, archive.open("xb") as target:
            try:
                import shutil
                shutil.copyfileobj(source, target)
            except BaseException:
                archive.unlink(missing_ok=True)
                raise
        return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/macos")
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    identity = os.environ.get("MAC_DEVELOPER_ID") if args.release else None
    profile = os.environ.get("MAC_NOTARY_PROFILE") if args.release else None
    if args.release and (not identity or not profile):
        parser.error("Release requires MAC_DEVELOPER_ID and MAC_NOTARY_PROFILE; no unsigned release is produced")
    archive = build(args.version, args.output.resolve(), identity, profile, os.environ.get("MAC_PROVISIONING_PROFILE"))
    print(f"{'Signed and notarized release' if args.release else 'Development build — do not distribute'}: {archive}")

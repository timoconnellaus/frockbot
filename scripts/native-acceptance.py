"""Physical-device evidence runner. Missing evidence stays missing, never zero.

inventory: wait for Pixel, read package version, pull installed APK and signer.
install: inventory + release build with greater versionCode + same-signer -r.
flow: supervised system-browser auth, named Bot, send/Stop/reconnect/Applet.
measure: 30 cold/warm activity launches and 20 resume cycles, memory/raw gfxinfo.

Activity TotalTime is NOT the first editable Flutter frame. gfxinfo is NOT a
substitute for Flutter build/raster traces. The report records that distinction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SERIAL = "adb-54261JEBF09176-BksSLE._adb-tls-connect._tcp"
PACKAGE = "com.frockbot.mobile"
EXPECTED_SIGNER = "61e6479f9c5755154c1f939cde48e8a757eff3136e54ed1dda5f61e78b3c1e37"
SDK = Path(os.environ.get("ANDROID_HOME", "/Users/tim/Library/Android/sdk"))
ADB = str(SDK / "platform-tools/adb")
OUT = ROOT / ".native-build/native-acceptance"
OUT.mkdir(parents=True, exist_ok=True)


def run(args, *, check=True, timeout=60, capture=True, env=None):
    return subprocess.run([str(a) for a in args], cwd=ROOT, check=check,
                          capture_output=capture, text=True, timeout=timeout, env=env)


def adb(*args, **kwargs):
    return run([ADB, "-s", SERIAL, *args], **kwargs)


def wait_device():
    # Read-only gate. A locked/offline phone must not hold up other milestones.
    devices = run([ADB, "devices"]).stdout.splitlines()
    if not any(line.split() == [SERIAL, "device"] for line in devices):
        raise RuntimeError("awaiting an unlocked phone: Pixel is offline")
    window = adb("shell", "dumpsys", "window").stdout
    policy = adb("shell", "dumpsys", "window", "policy").stdout
    keyguard = policy.split("KeyguardServiceDelegate", 1)[-1]
    if ("mDreamingLockscreen=true" in window or "isStatusBarKeyguard=true" in window
            or not re.search(r"^\s+showing=false$", keyguard, re.M)
            or not re.search(r"^\s+inputRestricted=false$", keyguard, re.M)):
        raise RuntimeError("awaiting an unlocked phone: keyguard is active or unconfirmed")


def write(name, value):
    (OUT / name).write_text(value if isinstance(value, str) else json.dumps(value, indent=2) + "\n")


def apksigner():
    tools = sorted((SDK / "build-tools").glob("*/apksigner"))
    if not tools:
        raise RuntimeError("Android apksigner is missing")
    return tools[-1]


def cert(apk, name):
    result = run([apksigner(), "verify", "--print-certs", apk]).stdout
    write(name, result)
    values = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", result)
    if len(values) != 1:
        raise RuntimeError("Expected exactly one APK signer")
    return values[0].lower()


def inventory():
    wait_device()
    package = adb("shell", "dumpsys", "package", PACKAGE).stdout
    versions = re.findall(r"versionCode=(\d+)", package)
    if not versions:
        raise RuntimeError("Existing FrockBot install is required; refusing a fresh install")
    version = int(versions[0])
    paths = adb("shell", "pm", "path", PACKAGE).stdout.splitlines()
    base = next((p.removeprefix("package:") for p in paths if p.endswith("/base.apk")), None)
    if not base:
        raise RuntimeError("Could not locate the installed base APK")
    old = OUT / "installed.apk"
    adb("pull", base, old)
    signer = cert(old, "installed-certificate.txt")
    if signer != EXPECTED_SIGNER:
        raise RuntimeError("Installed certificate differs from the existing debug key. No install attempted.")
    result = {
        "device": SERIAL, "package": PACKAGE, "installedVersionCode": version,
        "installedSignerSha256": signer, "os": adb("shell", "getprop", "ro.build.fingerprint").stdout.strip(),
        "release": adb("shell", "getprop", "ro.build.version.release").stdout.strip(),
        "gitHead": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write("inventory.json", result)
    write("display.txt", adb("shell", "dumpsys", "display").stdout)
    write("thermal.txt", adb("shell", "dumpsys", "thermalservice").stdout)
    print(json.dumps(result, indent=2), flush=True)
    return version


def install():
    version = inventory()
    # A marker proves package data was retained, without reading cookies/logins.
    marker = hashlib.sha256(os.urandom(32)).hexdigest()
    sentinel = "mkdir -p files && printf '%s' " + marker + " > files/native-continuity-proof"
    marker_written = adb("shell", "run-as", PACKAGE, "sh", "-c", "'" + sentinel + "'", check=False).returncode == 0
    environment = os.environ.copy()
    environment["FROCKBOT_INSTALLED_VERSION_CODE"] = str(version)
    environment["ANDROID_USER_HOME"] = str(ROOT / ".native-build/android-user")
    flutter = os.environ.get("NATIVE_FLUTTER", "/Users/tim/repos/flutter/bin/flutter")
    subprocess.run([flutter, "build", "apk", "--release", "--build-name=1.1.0",
                    f"--build-number={version + 1}", "--dart-define=NATIVE_ACCEPTANCE=true"],
                   cwd=ROOT / "apps/native", env=environment, check=True)
    apk = ROOT / "apps/native/build/app/outputs/flutter-apk/app-release.apk"
    signer = cert(apk, "candidate-certificate.txt")
    if signer != EXPECTED_SIGNER:
        raise RuntimeError("Candidate signer differs; refusing install")
    wait_device()
    # Recheck immediately before replacement; a concurrent upgrade cannot be downgraded.
    current = adb("shell", "dumpsys", "package", PACKAGE).stdout
    if int(re.search(r"versionCode=(\d+)", current).group(1)) >= version + 1:
        raise RuntimeError("Installed version changed during build; rerun inventory")
    output = adb("install", "-r", apk, timeout=180).stdout
    write("install.txt", output)
    if "Success" not in output:
        raise RuntimeError("APK replacement did not succeed")
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
    pid = adb("shell", "pidof", PACKAGE).stdout.strip()
    # The acceptance build reports only the hash of our random sentinel.
    # This works with release run-as disabled and never reads browser cookies.
    proof = adb("logcat", "-d", "--pid=" + pid, "-s", "FrockBotAccept:I").stdout
    continuity = marker_written and ("CONTINUITY " + hashlib.sha256(marker.encode()).hexdigest()) in proof
    write("continuity.json", {"markerWrittenBeforeUpgrade": marker_written,
                               "markerReadAfterUpgrade": continuity,
                               "sameUserAndBots": "unmeasured; verify after browser re-auth"})
    adb("shell", "pm", "verify-app-links", "--re-verify", PACKAGE, check=False)
    write("app-links.txt", adb("shell", "pm", "get-app-links", PACKAGE, check=False).stdout)
    print("Installed in place. Verified link and same-User/Bot recovery still require the flow run.")


def snapshot():
    wait_device()
    adb("shell", "uiautomator", "dump", "/data/local/tmp/frockbot-acceptance.xml", timeout=20)
    return ET.fromstring(adb("shell", "cat", "/data/local/tmp/frockbot-acceptance.xml").stdout)


def tap(label, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for node in snapshot().iter("node"):
            if label not in (node.get("text"), node.get("content-desc"), node.get("hint")):
                continue
            points = [int(n) for n in re.findall(r"\d+", node.get("bounds", ""))]
            if len(points) == 4:
                adb("shell", "input", "tap", str((points[0] + points[2]) // 2), str((points[1] + points[3]) // 2))
                return
        time.sleep(1)
    raise RuntimeError(f"Control not found: {label}. No succeeding step was inferred.")


def flow(bot_name, applet_name):
    if not bot_name or not applet_name:
        raise RuntimeError("flow requires --bot-name and --applet-name from the acceptance fixture")
    wait_device()
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
    if any(n.get("text") == "Continue with Google" or n.get("content-desc") == "Continue with Google" for n in snapshot().iter("node")):
        tap("Continue with Google")
    print("Complete Google sign-in in the system browser if needed. Waiting for the native Bot directory.", flush=True)
    # Auth is an OS/user action; this script never supplies a password or bypasses consent.
    tap("Open navigation menu", timeout=300)
    tap(bot_name)
    tap("Message")
    adb("shell", "input", "text", "Native%sslice%stwo:%splease%scount%sslowly%sto%s100.")
    tap("Send")
    tap("Stop")
    # Detach/reopen the observer; explicit Stop above is the only cancellation.
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
    tap("Reconnect", timeout=10) if any(n.get("content-desc") == "Reconnect" for n in snapshot().iter("node")) else None
    tap("Your Applets")
    tap(applet_name)
    write("flow.json", {"navigationStepsCompleted": True,
                        "durableReceiptCorrelation": "pending backend evidence",
                        "appletMutationPersistence": "pending real facet mutation and reconnect",
                        "computerHibernated": "pending backend evidence"})
    print("Navigation completed. Facet persistence and durable receipt correlation are separate required proofs.")


def parse_metrics(raw):
    # Android splits long Flutter print calls into unprefixed continuation
    # lines. Retain complete bounded records, never a truncated first line.
    records, pending, dropped = [], "", 0
    allowed = {"schemaVersion", "frames", "appInputToFrameMs", "firstPaintMs", "firstEditableFrameMs"}
    for line in raw.splitlines():
        if "FROCKBOT_METRICS " in line:
            dropped += bool(pending)
            pending = line.split("FROCKBOT_METRICS ", 1)[1]
        elif pending:
            pending += line
        else:
            continue
        if len(pending) > 32768:
            dropped += 1
            pending = ""
            continue
        try:
            value = json.loads(pending)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("schemaVersion") == 1 and set(value) <= allowed:
            records.append(value)
        else:
            dropped += 1
        pending = ""
    return {"records": records, "incompleteRecords": dropped + bool(pending)}


def capture_metrics():
    pid = adb("shell", "pidof", PACKAGE).stdout.strip()
    if not pid.isdigit():
        raise RuntimeError("The native app process is unavailable")
    raw = adb("logcat", "-d", "--pid=" + pid, "-s", "flutter:I", "-v", "raw").stdout
    return {"pid": int(pid), **parse_metrics(raw)}


def measure():
    wait_device()
    cold, warm, flutter = [], [], []
    for index in range(30):
        wait_device()
        adb("shell", "am", "force-stop", PACKAGE)
        cold.append(adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity").stdout)
        time.sleep(2)
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        warm.append(adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity").stdout)
        time.sleep(1)
        # Once per process, before the next cold launch kills it. Reading only
        # the final PID silently loses the first 29 launch observations.
        flutter.append({"launch": index + 1, **capture_metrics()})
        write("launches.json", {"activityCold": cold, "activityWarm": warm, "firstEditableFrame": None})
        write("flutter-launch-metrics.json", flutter)
    write("base-memory.txt", adb("shell", "dumpsys", "meminfo", PACKAGE).stdout)
    for _ in range(20):
        wait_device()
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(1)
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        time.sleep(1)
    write("after-resume-memory.txt", adb("shell", "dumpsys", "meminfo", PACKAGE).stdout)
    write("gfxinfo.txt", adb("shell", "dumpsys", "gfxinfo", PACKAGE, "framestats").stdout)
    write("flutter-resume-metrics.json", capture_metrics())
    write("measurement-status.json", {"threeFiveMinuteRuns": False, "flutterReleaseFrameTrace": False,
                                      "inputToPaintTrace": False, "firstEditableFrame30Launches": False,
                                      "applet20OpenCloseCycles": False, "exitCriteriaMet": False})
    print("Raw OS measurements saved. Required Flutter/IME/Applet traces are NOT implied by activity timing.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inventory", "install", "flow", "measure"])
    parser.add_argument("--bot-name")
    parser.add_argument("--applet-name")
    args = parser.parse_args()
    try:
        {"inventory": inventory, "install": install,
         "flow": lambda: flow(args.bot_name, args.applet_name), "measure": measure}[args.action]()
    except KeyboardInterrupt:
        print("Device acceptance paused; no missing check is marked passed.")
        raise SystemExit(130)

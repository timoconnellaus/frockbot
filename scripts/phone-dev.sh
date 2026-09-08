#!/usr/bin/env bash
# Separate local Android app; never installs over com.frockbot.mobile.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="${NATIVE_FLUTTER_ROOT:-/Users/tim/repos/flutter}/bin:${ANDROID_HOME:-/Users/tim/Library/Android/sdk}/platform-tools:$PATH"
serial="${FROCKBOT_PHONE_SERIAL:-adb-54261JEBF09176-BksSLE._adb-tls-connect._tcp}"
package=com.frockbot.mobile.dev
case "${1:-start}" in
  start) bun run dogfood:dev ;;
  install | connect) ;;
  *)
    echo 'Usage: scripts/phone-dev.sh [start|install|connect]' >&2
    exit 1
    ;;
esac
bun scripts/dogfood/phone-user.ts
adb -s "$serial" get-state
adb -s "$serial" reverse tcp:8787 tcp:8787
if [[ "${1:-start}" != connect ]]; then
  installed="$(adb -s "$serial" shell dumpsys package "$package" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)"
  export FROCKBOT_INSTALLED_VERSION_CODE="${installed:-0}"
  (
    cd apps/native
    flutter pub get --enforce-lockfile
    flutter build apk --release --build-number="$((FROCKBOT_INSTALLED_VERSION_CODE + 1))" --dart-define=FROCKBOT_LOCAL_DEV=true
  )
  apk=apps/native/build/app/outputs/flutter-apk/app-release.apk
  # Inspect the actual artifact before allowing installation.
  aapt="${FROCKBOT_AAPT2:-$(find "${ANDROID_HOME:-/Users/tim/Library/Android/sdk}/build-tools" -name aapt2 -type f | sort | tail -1)}"
  [[ -x "$aapt" ]] || {
    echo 'Android build-tools aapt2 is required' >&2
    exit 1
  }
  actual="$("$aapt" dump badging "$apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
  [[ "$actual" == "$package" ]] || {
    echo 'Refusing APK with unexpected identity' >&2
    exit 1
  }
  adb -s "$serial" install -r "$apk"
fi
adb -s "$serial" shell am start -n "$package/com.frockbot.mobile.MainActivity"
echo 'FrockBot (Dev) uses the local server as development. Keep wireless ADB connected.'

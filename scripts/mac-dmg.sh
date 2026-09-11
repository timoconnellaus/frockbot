#!/usr/bin/env bash
# Package a signed, stapled FrockBot.app as a Developer ID-signed disk image
# with the conventional drag-to-Applications layout. The image is what the
# website hands out; the caller notarizes and staples it afterwards, exactly
# as it did the app inside.
#
# usage: scripts/mac-dmg.sh <FrockBot.app> <output.dmg> <signing identity>
set -euo pipefail

app="${1:?app bundle path required}"
dmg="${2:?output image path required}"
identity="${3:?signing identity required}"

[[ -d "$app" ]] || {
  echo "app bundle not found: $app" >&2
  exit 1
}
[[ ! -e "$dmg" ]] || {
  echo "refusing to replace $dmg" >&2
  exit 1
}
[[ "$identity" == "Developer ID Application:"* ]] || {
  echo "a public disk image must be signed with a Developer ID Application identity" >&2
  exit 1
}

stage="$(mktemp -d "${TMPDIR:-/tmp}/frockbot-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/$(basename "$app")"
ln -s /Applications "$stage/Applications"

# hdiutil intermittently reports "Resource busy" on shared runners while the
# previous image detaches; a short retry is the standard mitigation.
for attempt in 1 2 3; do
  if hdiutil create -volname FrockBot -srcfolder "$stage" -fs HFS+ \
    -format UDZO -imagekey zlib-level=9 "$dmg" >/dev/null; then
    break
  fi
  rm -f "$dmg"
  ((attempt < 3)) || {
    echo "hdiutil failed three times" >&2
    exit 1
  }
  sleep 5
done

codesign --sign "$identity" --timestamp "$dmg"
codesign --verify --verbose=2 "$dmg"

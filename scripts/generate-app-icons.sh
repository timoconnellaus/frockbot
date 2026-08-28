#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE="$ROOT/assets/marketing/app-icon/frockbot-icon-1024.png"
DESKTOP="$ROOT/apps/desktop/resources"
ANDROID="$ROOT/apps/mobile/android/app/src/main/res"
IOS="$ROOT/apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset"
PINK="#ec386b"

command -v magick >/dev/null 2>&1 || {
  printf 'ImageMagick 7 (magick) is required to generate app icons.\n' >&2
  exit 1
}
[[ -f "$SOURCE" ]] || {
  printf 'Missing canonical icon: %s\n' "$SOURCE" >&2
  exit 1
}

mkdir -p "$DESKTOP/icons" "$IOS"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

clean_png() {
  local arguments=("$@")
  local last=$((${#arguments[@]} - 1))
  local output=${arguments[$last]}
  unset 'arguments[last]'
  magick "${arguments[@]}" -depth 8 -strip "$output"
}

# Linux packaging consumes a freedesktop-style directory of square PNG sizes.
for size in 16 32 48 64 128 256 512 1024; do
  clean_png "$SOURCE" -resize "${size}x${size}" "$DESKTOP/icons/${size}x${size}.png"
done

# Windows packages consume one multi-resolution ICO.
clean_png "$SOURCE" -define icon:auto-resize=256,128,64,48,32,16 "$DESKTOP/icon.ico"

# macOS packages consume an ICNS assembled from Apple's standard iconset names.
command -v iconutil >/dev/null 2>&1 || {
  printf 'macOS iconutil is required to generate resources/icon.icns.\n' >&2
  exit 1
}
iconset="$work/FrockBot.iconset"
mkdir -p "$iconset"
for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  read -r size name <<<"$spec"
  clean_png "$SOURCE" -resize "${size}x${size}" "$iconset/$name"
done
iconutil --convert icns --output "$DESKTOP/icon.icns" "$iconset"

# Android legacy launchers get a little breathing room on the brand-pink field.
# Adaptive foreground canvases are 108dp. The canonical image's face and
# glasses sit inside Android's 66dp safe zone; the adaptive mask supplies the
# final shape while the ears may extend into the maskable area.
for spec in \
  "mdpi 48 108" \
  "hdpi 72 162" \
  "xhdpi 96 216" \
  "xxhdpi 144 324" \
  "xxxhdpi 192 432"; do
  read -r density legacy foreground <<<"$spec"
  legacy_art=$((legacy * 88 / 100))
  safe_art=$foreground
  directory="$ANDROID/mipmap-$density"
  mkdir -p "$directory"

  clean_png -size "${legacy}x${legacy}" "xc:$PINK" \
    \( "$SOURCE" -resize "${legacy_art}x${legacy_art}" \) \
    -gravity center -compose over -composite "$directory/ic_launcher.png"
  cp "$directory/ic_launcher.png" "$directory/ic_launcher_round.png"
  clean_png -size "${foreground}x${foreground}" xc:none \
    \( "$SOURCE" -resize "${safe_art}x${safe_art}" \) \
    -gravity center -compose over -composite "$directory/ic_launcher_foreground.png"
done

# The current Xcode asset catalog uses the universal 1024px App Store icon.
# App Store icons cannot contain alpha, so flatten transparent corners to pink.
clean_png "$SOURCE" -background "$PINK" -alpha remove -alpha off \
  "PNG24:$IOS/AppIcon-512@2x.png"

printf 'Generated desktop, Android, and iOS icons from %s\n' "$SOURCE"

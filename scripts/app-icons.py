#!/usr/bin/env python3
"""Regenerate every FrockBot app icon from the Pixel sticker master.

    python3 scripts/app-icons.py

Needs Pillow and rsvg-convert (`brew install librsvg`). Writes the marketing
site icons, the repo-root marketing set (which build-artifact.ts ships as the
web app favicon), the Flutter web icons, the Android launcher set and both
macOS icon sets. Pixel is drawn on an ink tile with a pink glow; the feet clip
at the tile edge the same way the flock peeks over the site's hero.

Compositions
  tile(S)        rounded ink square, Pixel head-and-shoulders, feet clipped
  square(S)      full-bleed with Pixel inside the central safe zone; the OS
                 applies its own mask (Android adaptive, PWA maskable)
  foreground(S)  Pixel only on transparent, for the Android adaptive layer
  mac(S)         macOS style: the tile at ~80% of the canvas with a soft shadow
  dev(img)       black band with a yellow DEV label for development builds
"""
import pathlib
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
MASTER = ROOT / "output/flock-svg-rig/svg/pixel.svg"
INK = (30, 29, 39, 255)
INK_HEX = "#1E1D27"
PINK = (236, 56, 107)
DEV_BLACK = (12, 12, 12, 255)
DEV_YELLOW = (255, 200, 0, 255)
FONT = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
TILE_RADIUS = 0.2246  # the iOS/macOS corner ratio
MAC_INSET = (1 - 0.805) / 2


def render_master(width=1400):
    out = pathlib.Path(tempfile.mkdtemp()) / "pixel.png"
    subprocess.run(["rsvg-convert", "-w", str(width), str(MASTER), "-o", str(out)], check=True)
    return Image.open(out).convert("RGBA")


SRC = render_master()


def blank(S):
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def character(S, width_ratio, top_ratio):
    """Pixel scaled to width_ratio·S with the tuft at top_ratio·S, plus glow and contact shadow."""
    ch = SRC.resize(
        (round(S * width_ratio), round(S * width_ratio * SRC.height / SRC.width)),
        Image.LANCZOS,
    )
    layer = blank(S)
    layer.paste(ch, ((S - ch.width) // 2, round(S * top_ratio)), ch)
    glow = blank(S)
    r = round(S * 0.39)
    cy = round(S * 0.585)
    ImageDraw.Draw(glow).ellipse((S // 2 - r, cy - r, S // 2 + r, cy + r), fill=PINK + (110,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.146))
    shadow = blank(S)
    shadow.paste((0, 0, 0, 120), (0, 0, S, S), layer.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.027))
    return Image.alpha_composite(Image.alpha_composite(glow, shadow), layer)


def rounded_mask(S, radius, inset=0):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((inset, inset, S - 1 - inset, S - 1 - inset), radius, fill=255)
    return m


def ink(S, radius):
    bg = blank(S)
    ImageDraw.Draw(bg).rounded_rectangle((0, 0, S - 1, S - 1), radius, fill=INK)
    return bg


def tile(S):
    radius = round(S * TILE_RADIUS)
    art = Image.composite(character(S, 0.826, -0.01), blank(S), rounded_mask(S, radius))
    return Image.alpha_composite(ink(S, radius), art)


def square(S):
    return Image.alpha_composite(ink(S, 0), character(S, 0.62, 0.17))


def round_icon(S):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse((0, 0, S - 1, S - 1), fill=255)
    return Image.composite(square(S), blank(S), m)


def foreground(S):
    return character(S, 0.62, 0.17)


def mac(S):
    inner = round(S * 0.805)
    t = tile(inner)
    off = (S - inner) // 2
    drop = round(S * 0.012)
    shadow = blank(S)
    shadow.paste((0, 0, 0, 90), (off, off + drop, off + inner, off + inner + drop), t.split()[3])
    canvas = Image.alpha_composite(blank(S), shadow.filter(ImageFilter.GaussianBlur(S * 0.02)))
    canvas.paste(t, (off, off), t)
    return canvas


def dev(img, inset_ratio=0.0):
    S = img.width
    o = round(S * inset_ratio)
    inner = S - 2 * o
    band = blank(S)
    d = ImageDraw.Draw(band)
    top = o + round(inner * 0.73)
    d.rectangle((o, top, o + inner, o + inner), fill=DEV_BLACK)
    d.rectangle((o, top, o + inner, top + round(inner * 0.012)), fill=DEV_YELLOW)
    font = ImageFont.truetype(FONT, round(inner * 0.2))
    box = d.textbbox((0, 0), "DEV", font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(
        (o + (inner - tw) // 2 - box[0], top + (inner - (top - o) - th) // 2 - box[1]),
        "DEV",
        font=font,
        fill=DEV_YELLOW,
    )
    band = Image.composite(band, blank(S), rounded_mask(S, round(inner * TILE_RADIUS), o))
    return Image.alpha_composite(img, band)


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def main():
    site = ROOT / "apps/marketing/public/assets"
    save(tile(512), site / "app-icon.png")
    save(tile(64), site / "favicon.png")

    root_set = ROOT / "assets/marketing/app-icon"
    for n in (64, 128, 256, 512, 1024):
        save(tile(n), root_set / f"frockbot-icon-{n}.png")
    save(tile(1254), ROOT / "assets/marketing/frockbot-icon.png")

    web = ROOT / "apps/native/web"
    save(tile(32), web / "favicon.png")
    for n in (192, 512):
        save(tile(n), web / f"icons/Icon-{n}.png")
        save(square(n), web / f"icons/Icon-maskable-{n}.png")

    res = ROOT / "apps/native/android/app/src/main/res"
    for name, d in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
        save(foreground(round(108 * d)), res / f"mipmap-{name}/ic_launcher_foreground.png")
        save(tile(round(48 * d)), res / f"mipmap-{name}/ic_launcher.png")
        save(round_icon(round(48 * d)), res / f"mipmap-{name}/ic_launcher_round.png")
    (res / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">{INK_HEX}</color>\n'
        "</resources>"
    )

    xc = ROOT / "apps/native/macos/Runner/Assets.xcassets"
    for n in (16, 32, 64, 128, 256, 512, 1024):
        m = mac(n)
        save(m, xc / f"AppIcon.appiconset/app_icon_{n}.png")
        save(dev(m, MAC_INSET), xc / f"AppIconDev.appiconset/app_icon_{n}.png")
    print("app icons written")


if __name__ == "__main__":
    main()

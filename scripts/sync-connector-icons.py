#!/usr/bin/env python3
"""Refresh Marketplace model marks from Lobe Icons (MIT).

Catalog providers are compiled Packages, not Plugins. Their Connection Type
already names `icon: <provider.id>`. The Flutter host draws
`apps/native/assets/connectors/<icon>.png` or a letter tile. This script
fills those files from a pinned Lobe Icons PNG pack so a card looks like
the brand, the same way Gmail and Slack already do.

A Plugin still cannot ship an image: the descriptor has no assets field,
and cards are drawn by the host. A Plugin-served provider (DeepSeek) uses
this same host-bundled name.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "apps/native/assets/connectors"
PACKAGE = "@lobehub/icons-static-png"
VERSION = "1.94.0"
SIZE = 192

# provider.id → file inside package/light/. Prefer *-color when Lobe has one.
# One brand reused across regional variants is honest: the mark is the brand.
LOBE_FILES: dict[str, str] = {
    "amazon-bedrock": "bedrock-color.png",
    "ant-ling": "antgroup-color.png",
    "anthropic": "anthropic.png",
    "azure-openai-responses": "azure-color.png",
    "baseten": "baseten.png",
    "cerebras": "cerebras-color.png",
    "cloudflare-ai-gateway": "cloudflare-color.png",
    "cloudflare-workers-ai": "cloudflare-color.png",
    "deepseek": "deepseek-color.png",
    "fireworks": "fireworks-color.png",
    "github-copilot": "githubcopilot.png",
    "google": "google-color.png",
    "google-vertex": "vertexai-color.png",
    "groq": "groq.png",
    "huggingface": "huggingface-color.png",
    "kimi-coding": "kimi-color.png",
    "minimax": "minimax-color.png",
    "minimax-cn": "minimax-color.png",
    "mistral": "mistral-color.png",
    "moonshotai": "moonshot.png",
    "moonshotai-cn": "moonshot.png",
    "nvidia": "nvidia-color.png",
    "ollama": "ollama.png",
    "openai": "openai.png",
    "openai-codex": "codex-color.png",
    "opencode": "opencode.png",
    "opencode-go": "opencode.png",
    "openrouter": "openrouter-color.png",
    "qwen-token-plan": "qwen-color.png",
    "qwen-token-plan-cn": "qwen-color.png",
    "qwen-token-plan-individual": "qwen-color.png",
    "together": "together-color.png",
    "vercel-ai-gateway": "vercel.png",
    "xai": "xai.png",
    "xiaomi": "xiaomimimo.png",
    "xiaomi-token-plan-ams": "xiaomimimo.png",
    "xiaomi-token-plan-cn": "xiaomimimo.png",
    "xiaomi-token-plan-sgp": "xiaomimimo.png",
    "zai": "zhipu-color.png",
    "zai-coding-cn": "zhipu-color.png",
}

# No honest mark in the pack. The host draws a letter tile.
LETTER_TILE = frozenset({"radius"})

CONNECT_ICONS = (
    "gmail",
    "slack",
    "github",
    "notion",
    "googlecalendar",
    "googledrive",
)


def catalog_ids() -> list[str]:
    providers = json.loads((ROOT / "providers/catalog/providers.json").read_text())
    return [row["id"] for row in providers] + ["ollama"]


def tarball() -> Path:
    cache = Path("/tmp") / f"lobehub-icons-static-png-{VERSION}.tgz"
    if cache.exists() and cache.stat().st_size > 1000:
        return cache
    url = f"https://registry.npmjs.org/{PACKAGE}/-/{PACKAGE.rsplit('/', 1)[-1]}-{VERSION}.tgz"
    urllib.request.urlretrieve(url, cache)
    return cache


def resize(raw: bytes) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(raw)).convert("RGBA")
    image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def sync() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    archive = tarfile.open(tarball())
    try:
        for icon, source in LOBE_FILES.items():
            member = archive.extractfile(f"package/light/{source}")
            if member is None:
                raise SystemExit(f"missing {source} in {PACKAGE}@{VERSION}")
            (DEST / f"{icon}.png").write_bytes(resize(member.read()))
    finally:
        archive.close()
    print(f"wrote {len(LOBE_FILES)} marks to {DEST}")


def check() -> None:
    ids = catalog_ids()
    mapped = set(LOBE_FILES) | LETTER_TILE
    missing = [name for name in ids if name not in mapped]
    extra = sorted(set(LOBE_FILES) - set(ids))
    absent = [
        name for name in LOBE_FILES if not (DEST / f"{name}.png").exists()
    ]
    connect_absent = [
        name for name in CONNECT_ICONS if not (DEST / f"{name}.png").exists()
    ]
    errors = []
    if missing:
        errors.append(f"catalog ids with no mapping: {missing}")
    if extra:
        errors.append(f"mappings for unknown ids: {extra}")
    if absent:
        errors.append(f"mapped files missing: {absent}")
    if connect_absent:
        errors.append(f"connect marks missing: {connect_absent}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(
        f"ok: {len(LOBE_FILES)} catalog marks, "
        f"{len(LETTER_TILE)} letter-tile, {len(CONNECT_ICONS)} connect marks",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    sync()
    check()


if __name__ == "__main__":
    sys.exit(main())

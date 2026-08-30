#!/usr/bin/env python3
"""Validate that every promoted layer survives deterministic 32/64/256 composition."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).parent
ASSETS = ROOT / "assets"
SIZES = (32, 64, 256)
RESAMPLE = Image.Resampling.LANCZOS

manifest = json.loads((ASSETS / "manifest.json").read_text())
asset_by_id = {item["id"]: item for item in manifest["assets"]}
node_by_id = {
    node["id"]: node
    for band in ("upper", "middle", "lower")
    for node in manifest["trees"][band]
}

def image(asset_id: str) -> Image.Image:
    return Image.open(ASSETS / asset_by_id[asset_id]["file"]).convert("RGBA")

def path_for(node_id: str) -> list[str]:
    result: list[str] = []
    node = node_by_id[node_id]
    while node["parent"] is not None:
        result.insert(0, node["id"])
        node = node_by_id[node["parent"]]
    return result

def compose(layer_ids: list[str], size: int) -> Image.Image:
    output = Image.new("RGBA", (256, 256))
    for layer_id in layer_ids:
        output.alpha_composite(image(layer_id))
    return output.resize((size, size), RESAMPLE)

base_ids = ["background-hot-pink", "canonical"]
checked = 0
for size in SIZES:
    base = compose(base_ids, size)
    assert base.getbbox(), f"empty canonical composition at {size}px"
    assert sum(ImageStat.Stat(base.convert("RGB")).var) > 1, f"flat canonical at {size}px"
    for background in manifest["backgrounds"]:
        candidate = compose([f"background-{background['id']}", "canonical"], size)
        assert candidate.getbbox(), f"background {background['id']} is empty at {size}px"
        if background["id"] != "hot-pink":
            assert ImageChops.difference(base, candidate).convert("RGB").getbbox(), (
                f"background {background['id']} is indistinguishable at {size}px"
            )
        checked += 1
    for band in ("upper", "middle", "lower"):
        for node in manifest["trees"][band]:
            if node["parent"] is None:
                continue
            layers = base_ids + path_for(node["id"])
            candidate = compose(layers, size)
            assert ImageChops.difference(base, candidate).convert("RGB").getbbox(), (
                f"wearable {node['id']} disappears at {size}px"
            )
            checked += 1

print(f"validated {checked} background/wearable compositions at 32/64/256px")

#!/usr/bin/env python3
"""Fetch the pinned Deno that runs device modules (ADR 0037), checked by hash."""
import argparse
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

VERSION = "2.9.7"
# From https://dl.deno.land/release/v<VERSION>/deno-<target>.zip.sha256sum.
SHA256 = {
    "aarch64-apple-darwin": "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
    "x86_64-apple-darwin": "95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a",
    # A Bot's Computer fetches these itself for `plugin_module_try`; the
    # version and hashes it uses are PLUGIN_MODULE_TRY_DENO_V1, kept equal by
    # computer/module-try.test.ts.
    "aarch64-unknown-linux-gnu": "c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf",
    "x86_64-unknown-linux-gnu": "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490",
}


def fetch(target, destination):
    if target not in SHA256:
        raise ValueError(f"No pinned Deno for {target}")
    url = f"https://dl.deno.land/release/v{VERSION}/deno-{target}.zip"
    request = urllib.request.Request(url, headers={"User-Agent": "frockbot-fetch-deno"})
    with urllib.request.urlopen(request) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != SHA256[target]:
        raise RuntimeError(f"{url} is {digest}, not the pinned {SHA256[target]}")
    with zipfile.ZipFile(io.BytesIO(archive)) as unpacked:
        binary = unpacked.read("deno")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(binary)
    destination.chmod(0o755)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=sorted(SHA256))
    parser.add_argument("destination")
    arguments = parser.parse_args()
    print(fetch(arguments.target, arguments.destination))

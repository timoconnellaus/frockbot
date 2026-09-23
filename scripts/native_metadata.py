"""Checked access to the native build metadata command.

Python release tools consume this decoder instead of scraping Dart, YAML, or
generated TypeScript. The Bun command owns source parsing and compatibility
checks; this boundary rejects incomplete or mistyped command output.
"""

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
from typing import Optional


@dataclass(frozen=True)
class NativeMetadata:
    release: Optional[str]
    version_name: str
    build_number: int
    version: str
    hosted_origin: str
    client_protocol: int
    protocol_min: int
    protocol_max: int


def _integer(value, label):
    if type(value) is not int:
        raise RuntimeError(f"Native metadata {label} must be an integer.")
    return value


def decode_native_metadata(source):
    try:
        document = json.loads(source)
        app = document["app"]
        compatibility = document["compatibility"]
        metadata = NativeMetadata(
            release=document["release"],
            version_name=app["versionName"],
            build_number=_integer(app["buildNumber"], "app.buildNumber"),
            version=app["version"],
            hosted_origin=document["hostedOrigin"],
            client_protocol=_integer(document["clientProtocol"], "clientProtocol"),
            protocol_min=_integer(compatibility["protocolMin"], "compatibility.protocolMin"),
            protocol_max=_integer(compatibility["protocolMax"], "compatibility.protocolMax"),
        )
    except (json.JSONDecodeError, KeyError, TypeError) as failure:
        raise RuntimeError("Native metadata command returned an invalid document.") from failure
    if document.get("schemaVersion") != 1:
        raise RuntimeError("Native metadata command returned an unsupported schema version.")
    for label, value in (
        ("app.versionName", metadata.version_name),
        ("app.version", metadata.version),
        ("hostedOrigin", metadata.hosted_origin),
    ):
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"Native metadata {label} must be a non-empty string.")
    if metadata.release is not None and (not isinstance(metadata.release, str) or not metadata.release):
        raise RuntimeError("Native metadata release must be a non-empty string or null.")
    if metadata.version != f"{metadata.version_name}+{metadata.build_number}":
        raise RuntimeError("Native metadata app version does not match its name and build number.")
    if not metadata.hosted_origin.startswith("https://"):
        raise RuntimeError("Native metadata hostedOrigin must be HTTPS.")
    if not metadata.protocol_min <= metadata.client_protocol <= metadata.protocol_max:
        raise RuntimeError("Native metadata client protocol is outside its compatibility range.")
    return metadata


def read_native_metadata(repository_root):
    root = Path(repository_root).resolve()
    command = Path(__file__).with_name("native-metadata.ts")
    result = subprocess.run(
        ["bun", command, "--root", root],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Could not read native build metadata: {detail}")
    return decode_native_metadata(result.stdout)

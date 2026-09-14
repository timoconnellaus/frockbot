#!/usr/bin/env python3
"""Sign the notarized Mac disk image and write the Sparkle feed that offers it.

The feed names exactly one release — the newest — so an app that has been
closed through several releases updates once, straight to the latest, rather
than stepping through each. A feed never moves backwards: writing an older
build over a newer one is refused.

Signing is Ed25519 over the archive bytes, as Sparkle's `sign_update` does,
implemented here from RFC 8032 so the release job needs no downloaded tool.
The private key is the base64 value Sparkle's `generate_keys -x` exports.
"""
import argparse
import base64
from email.utils import formatdate
import hashlib
import os
from pathlib import Path
import re
import sys
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"

# --- Ed25519 (RFC 8032, section 5.1) -------------------------------------
P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def _add(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    e = (y1 - x1) * (y2 - x2) % P
    f = (y1 + x1) * (y2 + x2) % P
    g = 2 * t1 * t2 * D % P
    h = 2 * z1 * z2 % P
    e, f, g, h = f - e, h - g, h + g, f + e
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _multiply(scalar, point):
    result = (0, 1, 1, 0)
    while scalar:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _recover_x(y, sign):
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    return P - x if (x & 1) != sign else x


_BY = 4 * pow(5, P - 2, P) % P
_BX = _recover_x(_BY, 0)
BASE = (_BX, _BY, 1, _BX * _BY % P)


def _compress(point):
    x, y, z, _ = point
    zinv = pow(z, P - 2, P)
    x, y = x * zinv % P, y * zinv % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(data):
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


def _equal(a, b):
    return (a[0] * b[2] - b[0] * a[2]) % P == 0 and (a[1] * b[2] - b[1] * a[2]) % P == 0


def _hash_int(*parts):
    digest = hashlib.sha512()
    for part in parts:
        if isinstance(part, (bytes, bytearray)):
            digest.update(part)
        else:
            for chunk in part:
                digest.update(chunk)
    return int.from_bytes(digest.digest(), "little")


class SigningKey:
    """A Sparkle EdDSA key: the 32-byte seed `generate_keys -x` exports."""

    def __init__(self, encoded):
        raw = base64.b64decode(encoded.strip(), validate=True)
        if len(raw) != 32:
            raise ValueError("A Sparkle private key is 32 bytes of base64")
        expanded = hashlib.sha512(raw).digest()
        scalar = bytearray(expanded[:32])
        scalar[0] &= 248
        scalar[31] &= 127
        scalar[31] |= 64
        self.scalar = int.from_bytes(scalar, "little")
        self.prefix = expanded[32:]
        self.public = _compress(_multiply(self.scalar, BASE))

    @property
    def public_base64(self):
        return base64.b64encode(self.public).decode()

    def sign(self, chunks):
        """Signs the concatenation of `chunks`, read twice: pass a callable."""
        r = _hash_int(self.prefix, chunks()) % Q
        R = _compress(_multiply(r, BASE))
        k = _hash_int(R, self.public, chunks()) % Q
        s = (r + k * self.scalar) % Q
        return R + int.to_bytes(s, 32, "little")


def verify(public, signature, chunks):
    if len(signature) != 64:
        return False
    point = _decompress(public)
    R = _decompress(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if point is None or R is None or s >= Q:
        return False
    k = _hash_int(signature[:32], public, chunks()) % Q
    return _equal(_multiply(s, BASE), _add(R, _multiply(k, point)))


def file_chunks(path):
    def read():
        with open(path, "rb") as source:
            while chunk := source.read(1 << 20):
                yield chunk
    return read


# --- the feed ------------------------------------------------------------

def feed_build(text):
    """The highest build a feed already offers, or None for an empty feed."""
    if not text or not text.strip():
        return None
    root = ElementTree.fromstring(text)
    builds = [int(node.text) for node in root.iter(f"{{{SPARKLE}}}version")
              if node.text and node.text.strip().isdigit()]
    return max(builds) if builds else None


def appcast(*, version, build, url, length, signature, minimum_system, published=None):
    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Version must be major.minor.patch")
    if not str(build).isdigit():
        raise ValueError("Build must be the bundle's numeric CFBundleVersion")
    if not url.startswith("https://"):
        raise ValueError("The update must be served over HTTPS")
    date = published or formatdate(usegmt=True)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<rss version="2.0" xmlns:sparkle="{SPARKLE}">\n'
        "  <channel>\n"
        "    <title>FrockBot</title>\n"
        "    <item>\n"
        f"      <title>{escape(version)}</title>\n"
        f"      <pubDate>{escape(date)}</pubDate>\n"
        f"      <sparkle:version>{build}</sparkle:version>\n"
        f"      <sparkle:shortVersionString>{escape(version)}</sparkle:shortVersionString>\n"
        f"      <sparkle:minimumSystemVersion>{escape(minimum_system)}</sparkle:minimumSystemVersion>\n"
        f"      <enclosure url={quoteattr(url)} length=\"{length}\" type=\"application/octet-stream\"\n"
        f"        sparkle:edSignature={quoteattr(base64.b64encode(signature).decode())} />\n"
        "    </item>\n"
        "  </channel>\n"
        "</rss>\n"
    )


def publishable(*, key, public_key, archive, version, build, url, minimum_system, current=None, published=None):
    """The feed to publish, or None when the current feed is already newer."""
    signing = SigningKey(key)
    if signing.public_base64 != public_key.strip():
        raise ValueError("The signing key does not match the public key the app was built with")
    existing = feed_build(current)
    if existing is not None and existing > int(build):
        return None
    chunks = file_chunks(archive)
    signature = signing.sign(chunks)
    if not verify(signing.public, signature, chunks):
        raise RuntimeError("The archive signature did not verify")
    return appcast(version=version, build=build, url=url, length=Path(archive).stat().st_size,
                   signature=signature, minimum_system=minimum_system, published=published)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--minimum-system", required=True,
                        help="the app bundle's LSMinimumSystemVersion")
    parser.add_argument("--current", type=Path, help="the feed being replaced, if any")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get("SPARKLE_ED_PRIVATE_KEY", "")
    public_key = os.environ.get("SPARKLE_ED_PUBLIC_KEY", "")
    if not key or not public_key:
        parser.error("SPARKLE_ED_PRIVATE_KEY and SPARKLE_ED_PUBLIC_KEY are required")
    current = args.current.read_text() if args.current and args.current.exists() else None
    feed = publishable(key=key, public_key=public_key, archive=args.archive, version=args.version,
                       build=args.build, url=args.url, minimum_system=args.minimum_system, current=current)
    if feed is None:
        sys.exit(f"The current feed offers build {feed_build(current)}, newer than {args.build}")
    args.output.write_text(feed)
    print(f"Wrote {args.output} offering {args.version} ({args.build})")


if __name__ == "__main__":
    main()

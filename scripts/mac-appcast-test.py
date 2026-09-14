import base64
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from xml.etree import ElementTree

spec = importlib.util.spec_from_file_location("appcast", Path(__file__).with_name("mac-appcast.py"))
appcast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(appcast)

SPARKLE = "{" + appcast.SPARKLE + "}"


def key(hex_seed):
    return base64.b64encode(bytes.fromhex(hex_seed)).decode()


def chunks(data, size=7):
    return lambda: (data[i:i + size] for i in range(0, len(data), size))


SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"


class SigningTests(unittest.TestCase):
    def test_matches_rfc_8032_vectors(self):
        for seed, public, message, signature in [
            ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
             "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
             "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
            (SEED, "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
             "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
        ]:
            signing = appcast.SigningKey(key(seed))
            self.assertEqual(signing.public.hex(), public)
            self.assertEqual(signing.sign(chunks(bytes.fromhex(message))).hex(), signature)

    def test_a_changed_archive_does_not_verify(self):
        signing = appcast.SigningKey(key(SEED))
        data = os.urandom(3000)
        signature = signing.sign(chunks(data, 1000))
        self.assertTrue(appcast.verify(signing.public, signature, chunks(data)))
        tampered = bytes([data[0] ^ 1]) + data[1:]
        self.assertFalse(appcast.verify(signing.public, signature, chunks(tampered)))

    def test_rejects_a_key_that_is_not_a_32_byte_seed(self):
        seed = appcast.SigningKey(key(SEED))
        for encoded in (base64.b64encode(b"short").decode(),
                        base64.b64encode(seed.scalar.to_bytes(32, "little")
                                         + seed.prefix + seed.public).decode()):
            with self.assertRaises(ValueError):
                appcast.SigningKey(encoded)


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.archive = Path(self.directory.name) / "FrockBot-macos.dmg"
        self.archive.write_bytes(os.urandom(5000))
        self.signing = appcast.SigningKey(key(SEED))

    def tearDown(self):
        self.directory.cleanup()

    def feed(self, build, current=None, public=None):
        return appcast.publishable(
            key=key(SEED), public_key=public or self.signing.public_base64, archive=self.archive,
            version="1.4.0", build=build,
            url="https://downloads.frockbot.com/mac/FrockBot-macos-1.4.0.dmg",
            minimum_system="13.0", current=current, published="Mon, 14 Sep 2026 00:00:00 GMT")

    def test_offers_one_signed_release_sparkle_can_read(self):
        root = ElementTree.fromstring(self.feed("812"))
        items = root.findall("./channel/item")
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item.find(SPARKLE + "version").text, "812")
        self.assertEqual(item.find(SPARKLE + "shortVersionString").text, "1.4.0")
        self.assertEqual(item.find(SPARKLE + "minimumSystemVersion").text, "13.0")
        enclosure = item.find("enclosure")
        self.assertEqual(enclosure.get("length"), "5000")
        self.assertTrue(enclosure.get("url").startswith("https://downloads.frockbot.com/"))
        signature = base64.b64decode(enclosure.get(SPARKLE + "edSignature"))
        self.assertTrue(appcast.verify(self.signing.public, signature, appcast.file_chunks(self.archive)))

    def test_replaces_an_older_release_instead_of_adding_to_it(self):
        older = self.feed("700")
        newer = ElementTree.fromstring(self.feed("812", current=older))
        self.assertEqual([node.text for node in newer.iter(SPARKLE + "version")], ["812"])

    def test_never_moves_a_feed_backwards(self):
        self.assertIsNone(self.feed("700", current=self.feed("812")))
        self.assertIsNotNone(self.feed("812", current=self.feed("812")))

    def test_refuses_a_key_the_app_was_not_built_with(self):
        other = appcast.SigningKey(key("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
        with self.assertRaises(ValueError):
            self.feed("812", public=other.public_base64)

    def test_command_refuses_an_older_build(self):
        current = Path(self.directory.name) / "current.xml"
        current.write_text(self.feed("900"))
        output = Path(self.directory.name) / "appcast.xml"
        environment = {**os.environ, "SPARKLE_ED_PRIVATE_KEY": key(SEED),
                       "SPARKLE_ED_PUBLIC_KEY": self.signing.public_base64}
        command = [sys.executable, str(Path(__file__).with_name("mac-appcast.py")),
                   "--archive", str(self.archive), "--version", "1.4.0", "--build", "812",
                   "--url", "https://downloads.frockbot.com/mac/FrockBot-macos-1.4.0.dmg",
                   "--minimum-system", "13.0",
                   "--current", str(current), "--output", str(output)]
        refused = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse(output.exists())
        current.unlink()
        written = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertEqual(written.returncode, 0, written.stderr)
        self.assertEqual(appcast.feed_build(output.read_text()), 812)


if __name__ == "__main__":
    unittest.main()

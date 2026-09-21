import hashlib
import io
import struct
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

import crx3


def parse_fields(data):
    """Parse length-delimited protobuf fields into {field number: [payload]}."""
    fields = {}
    position = 0
    while position < len(data):
        key, position = read_varint(data, position)
        wire_type = key & 0x07
        if wire_type != 2:
            raise AssertionError(f"unexpected wire type {wire_type}")
        length, position = read_varint(data, position)
        fields.setdefault(key >> 3, []).append(data[position:position + length])
        position += length
    return fields


def read_varint(data, position):
    value = shift = 0
    while True:
        byte = data[position]
        position += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, position
        shift += 7


class Crx3Tests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.directory = Path(workspace.name)

        self.extension = self.directory / "extension"
        (self.extension / "sub").mkdir(parents=True)
        (self.extension / "manifest.json").write_text('{"manifest_version": 3}\n')
        (self.extension / "sub" / "background.js").write_text("// hello\n")
        (self.extension / ".hidden").write_text("secret\n")

        self.key = self.directory / "extension.pem"
        subprocess.run(
            ["openssl", "genrsa", "-out", str(self.key), "2048"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.crx = self.directory / "packed.crx"

    def read_crx(self):
        """Split the packed file into its header fields and zip payload."""
        data = self.crx.read_bytes()
        self.assertEqual(data[:4], b"Cr24")
        version, header_size = struct.unpack("<II", data[4:12])
        self.assertEqual(version, 3)
        header = parse_fields(data[12:12 + header_size])
        return header, data[12 + header_size:], data

    def test_signature_verifies_over_context_header_and_archive(self):
        crx3.pack(self.extension, self.key, self.crx)
        header, archive, _ = self.read_crx()

        self.assertNotIn(3, header, "no ECDSA proof should be emitted")
        proof = parse_fields(header[2][0])
        public_key, signature = proof[1][0], proof[2][0]
        signed_header_data = header[10000][0]

        public_key_file = self.directory / "public.der"
        public_key_file.write_bytes(public_key)
        signature_file = self.directory / "signature.bin"
        signature_file.write_bytes(signature)
        verified = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(public_key_file),
             "-keyform", "DER", "-signature", str(signature_file)],
            input=crx3.SIGNATURE_CONTEXT + struct.pack("<I", len(signed_header_data))
            + signed_header_data + archive,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(verified.returncode, 0, verified.stderr.decode())

    def test_crx_id_and_printed_extension_id_derive_from_the_key(self):
        printed = crx3.pack(self.extension, self.key, self.crx)
        header, _, _ = self.read_crx()

        public_key = parse_fields(header[2][0])[1][0]
        self.assertEqual(public_key, crx3.public_key_der(self.key))

        crx_id = parse_fields(header[10000][0])[1][0]
        self.assertEqual(crx_id, hashlib.sha256(public_key).digest()[:16])
        self.assertEqual(printed, crx3.extension_id(public_key))
        self.assertRegex(printed, r"^[a-p]{32}$")

    def test_archive_holds_the_extension_files_and_skips_hidden_ones(self):
        crx3.pack(self.extension, self.key, self.crx)
        _, archive, _ = self.read_crx()

        with zipfile.ZipFile(io.BytesIO(archive)) as packed:
            self.assertIsNone(packed.testzip())
            self.assertEqual(packed.namelist(), ["manifest.json", "sub/background.js"])
            self.assertEqual(packed.read("sub/background.js"), b"// hello\n")

    def test_repeated_packs_are_byte_identical(self):
        crx3.pack(self.extension, self.key, self.crx)
        first = self.crx.read_bytes()
        crx3.pack(self.extension, self.key, self.crx)
        self.assertEqual(first, self.crx.read_bytes())

    def test_empty_extension_directory_fails(self):
        empty = self.directory / "empty"
        empty.mkdir()
        with self.assertRaises(RuntimeError):
            crx3.pack(empty, self.key, self.crx)

    def test_unusable_key_fails(self):
        broken = self.directory / "broken.pem"
        broken.write_text("not a key\n")
        with self.assertRaises(RuntimeError):
            crx3.pack(self.extension, broken, self.crx)


if __name__ == "__main__":
    unittest.main()

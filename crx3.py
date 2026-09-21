#!/usr/bin/env python3
"""
Pack an unpacked extension directory into a signed CRX3 file.

Chromium's `--pack-extension` does the same job, but installing a whole browser
(plus a virtual X display) just to emit a few hundred bytes of header is a lot
of machinery for a zip with a signature stapled to the front. The container is
documented in Chromium's components/crx_file/crx3.proto and crx_verifier.cc:

    "Cr24" | uint32 version (3) | uint32 header length | header | zip

The header is a CrxFileHeader protobuf holding the RSA public key, the
signature, and a SignedData message carrying the 16-byte extension ID. The
signature covers a fixed context string, the SignedData block, and the zip.

Only the `openssl` command line is needed, which pack.sh already requires for
generating keys.
"""
import hashlib
import io
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

# crx_verifier.cc prepends this to the signed payload so a signature made for
# one purpose cannot be replayed as a CRX signature.
SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"

# Every entry gets the same timestamp so repeated packs of unchanged sources
# produce byte-identical output. Zip timestamps start at 1980.
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def encode_varint(value):
    """Encode an integer as a protobuf base-128 varint."""
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def encode_bytes_field(field_number, payload):
    """Encode one length-delimited (wire type 2) protobuf field."""
    return encode_varint(field_number << 3 | 2) + encode_varint(len(payload)) + payload


def openssl(arguments, stdin=b""):
    """Run openssl and return its stdout, failing loudly on a non-zero exit."""
    result = subprocess.run(
        ["openssl", *arguments],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"openssl {' '.join(arguments)} failed: {message}")
    return result.stdout


def public_key_der(key_file):
    """Return the DER SubjectPublicKeyInfo for a PEM private key."""
    return openssl(["rsa", "-in", str(key_file), "-passin", "pass:", "-pubout", "-outform", "DER"])


def extension_id(public_key):
    """Derive the extension ID Chromium shows, i.e. hex digits mapped to a-p."""
    digest = hashlib.sha256(public_key).digest()[:16]
    return digest.hex().translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))


def build_zip(extension_dir):
    """Zip the extension directory so identical sources give identical bytes."""
    extension_dir = Path(extension_dir)
    files = sorted(path for path in extension_dir.rglob("*") if path.is_file())
    # Hidden files are editor backups and version-control metadata, not things
    # to ship in a signed package; Chromium's packer skips them too.
    files = [
        path for path in files
        if not any(part.startswith(".") for part in path.relative_to(extension_dir).parts)
    ]
    if not files:
        raise RuntimeError(f"No files to pack in {extension_dir}")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            info = zipfile.ZipInfo(path.relative_to(extension_dir).as_posix(), FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    return buffer.getvalue()


def pack(extension_dir, key_file, crx_out):
    """Write a signed CRX3 for extension_dir and return its extension ID."""
    archive = build_zip(extension_dir)
    public_key = public_key_der(key_file)

    # SignedData { bytes crx_id = 1 } — the first half of the key's SHA-256.
    signed_header_data = encode_bytes_field(1, hashlib.sha256(public_key).digest()[:16])

    signature = openssl(
        ["dgst", "-sha256", "-sign", str(key_file), "-passin", "pass:"],
        SIGNATURE_CONTEXT + struct.pack("<I", len(signed_header_data)) + signed_header_data + archive,
    )

    # AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2 }
    proof = encode_bytes_field(1, public_key) + encode_bytes_field(2, signature)
    # CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
    #                 bytes signed_header_data = 10000 }
    header = encode_bytes_field(2, proof) + encode_bytes_field(10000, signed_header_data)

    Path(crx_out).write_bytes(
        b"Cr24" + struct.pack("<II", 3, len(header)) + header + archive
    )
    return extension_id(public_key)


def main(argv):
    if len(argv) != 4:
        print(f"Usage: {Path(argv[0]).name} <extension-dir> <key.pem> <output.crx>", file=sys.stderr)
        return 2
    print(pack(argv[1], argv[2], argv[3]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

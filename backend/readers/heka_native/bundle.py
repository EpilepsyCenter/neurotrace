"""Parse the DAT2 bundle header to locate sub-files (.pul, .pgf, .dat, .amp)."""

from __future__ import annotations

import struct
from dataclasses import dataclass


@dataclass
class BundleItem:
    extension: str
    start: int
    length: int


@dataclass
class BundleHeader:
    signature: str       # "DAT2"
    version: str         # e.g. "v2x90.5, 22-Nov-2016"
    is_little_endian: bool
    items: list[BundleItem]

    def find(self, ext: str) -> BundleItem | None:
        """Find a sub-file by extension (e.g. '.pul', '.pgf', '.dat')."""
        for item in self.items:
            if item.extension == ext:
                return item
        return None


def parse_bundle_header(data: bytes) -> BundleHeader:
    """Parse the 256-byte bundle header from a DAT2 file."""
    magic = data[:4]
    if magic not in (b'DAT2', b'DAT1', b'DATA'):
        raise ValueError(f"Not a HEKA bundle file (magic: {magic!r})")

    if magic == b'DAT1':
        raise ValueError("DAT1 (big-endian) files are not supported. Only DAT2.")

    signature = data[:8].split(b'\x00')[0].decode('ascii', errors='replace')
    version = data[8:40].split(b'\x00')[0].decode('ascii', errors='replace')

    # oItems at offset 48
    n_items = struct.unpack_from('<i', data, 48)[0]
    n_items = min(n_items, 12)  # Max 12 bundle items

    # oIsLittleEndian at offset 52
    is_le = bool(data[52])

    # BundleItem array at offset 64, each 16 bytes
    items: list[BundleItem] = []
    for i in range(n_items):
        base = 64 + i * 16
        start = struct.unpack_from('<i', data, base)[0]
        length = struct.unpack_from('<i', data, base + 4)[0]
        ext = data[base + 8: base + 16].split(b'\x00')[0].decode('ascii', errors='replace')
        if start > 0 and length > 0:
            items.append(BundleItem(extension=ext, start=start, length=length))

    return BundleHeader(
        signature=signature,
        version=version,
        is_little_endian=is_le,
        items=items,
    )

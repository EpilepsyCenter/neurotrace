"""Generic tree walker for HEKA binary tree format (.pul, .pgf, .amp, etc.).

All HEKA tree sub-files share the same header + depth-first record layout:

    Header:
        INT32   magic       (0x54726565 = "Tree")
        INT32   n_levels
        INT32[] level_sizes (one per level)

    Records (depth-first, pre-order):
        For each node:
            INT32   n_children
            BYTE[]  record_data (size = level_sizes[level])
            then recursively: n_children child nodes at level+1
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class TreeHeader:
    magic: bytes
    n_levels: int
    level_sizes: list[int]
    data_offset: int   # byte offset where the first record starts


@dataclass
class TreeNode:
    level: int
    record_offset: int   # byte offset of the record data within the file
    record_size: int     # number of bytes for this record
    children: list['TreeNode'] = field(default_factory=list)


def parse_tree_header(data: bytes, offset: int) -> TreeHeader:
    """Parse the tree header and return the level sizes + data start offset."""
    magic = data[offset:offset + 4]
    n_levels = struct.unpack_from('<i', data, offset + 4)[0]

    if n_levels < 1 or n_levels > 10:
        raise ValueError(f"Invalid tree level count: {n_levels}")

    level_sizes = []
    for i in range(n_levels):
        sz = struct.unpack_from('<i', data, offset + 8 + i * 4)[0]
        level_sizes.append(sz)

    data_offset = offset + 8 + n_levels * 4
    return TreeHeader(magic=magic, n_levels=n_levels, level_sizes=level_sizes, data_offset=data_offset)


def walk_tree(data: bytes, header: TreeHeader) -> TreeNode:
    """Walk the tree depth-first and return the root TreeNode with all children populated.

    Each TreeNode stores the byte offset and size of its record data,
    allowing the caller to parse specific fields on demand.
    """
    pos = header.data_offset

    def _walk(level: int) -> tuple[TreeNode, int]:
        nonlocal pos

        if level >= header.n_levels:
            raise ValueError(f"Exceeded tree depth at level {level}")

        n_children = struct.unpack_from('<i', data, pos)[0]
        pos += 4

        record_offset = pos
        record_size = header.level_sizes[level]
        pos += record_size

        node = TreeNode(
            level=level,
            record_offset=record_offset,
            record_size=record_size,
        )

        for _ in range(n_children):
            child, pos = _walk(level + 1), pos
            # _walk updates pos via the nonlocal; just collect the child
            node.children.append(child)

        return node

    # Walk is a bit tricky because _walk uses nonlocal pos.
    # Let's do it iteratively-recursively for clarity:
    def _walk_node(level: int) -> TreeNode:
        nonlocal pos

        # Record data comes FIRST, then the child count.
        # (Official HEKA FileFormat.txt: "Read record, then Read n children")
        record_offset = pos
        record_size = header.level_sizes[level]
        pos += record_size

        n_children = struct.unpack_from('<i', data, pos)[0]
        pos += 4

        node = TreeNode(
            level=level,
            record_offset=record_offset,
            record_size=record_size,
        )

        for _ in range(n_children):
            child = _walk_node(level + 1)
            node.children.append(child)

        return node

    return _walk_node(0)


def read_str(data: bytes, offset: int, length: int) -> str:
    """Read a null-terminated string from the data."""
    raw = data[offset:offset + length]
    return raw.split(b'\x00')[0].decode('latin-1', errors='replace').strip()


def read_i32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<i', data, offset)[0]


def read_u16(data: bytes, offset: int) -> int:
    return struct.unpack_from('<H', data, offset)[0]


def read_f64(data: bytes, offset: int) -> float:
    return struct.unpack_from('<d', data, offset)[0]


def read_u8(data: bytes, offset: int) -> int:
    return data[offset]


def read_bool(data: bytes, offset: int) -> bool:
    return bool(data[offset])

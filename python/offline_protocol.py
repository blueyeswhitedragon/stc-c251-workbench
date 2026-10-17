"""Offline-only STC32 data models and HEX preparation helpers.

This module deliberately has no serial imports and no device-writing API.  It
prepares deterministic data for tests and future review; it does not claim
that the resulting blocks are valid STC32 ISP write packets.
"""

from dataclasses import dataclass
import hashlib


STC32G12K128_MAGIC = 0xF7E3


class OfflineProtocolError(ValueError):
    """Invalid offline input."""


class ProgrammingDisabled(RuntimeError):
    """Raised if callers try to turn preparation into a hardware operation."""


@dataclass(frozen=True)
class StatusModel:
    model: str
    magic: int
    bsl_version: str | None
    raw_payload: bytes
    hardware_options_trust: str = "unverified_for_stc32"

    @property
    def flash_write_performed(self):
        return False

    def as_dict(self):
        return {
            "schema_version": 1,
            "model": self.model,
            "model_magic": f"0x{self.magic:04X}",
            "bsl_version": self.bsl_version,
            "raw_status_payload_hex": self.raw_payload.hex(),
            "raw_status_payload_bytes": len(self.raw_payload),
            "hardware_options_trust": self.hardware_options_trust,
            "reset_pin_enabled": None,
            "configured_eeprom_bytes": None,
            "flash_write_performed": False,
        }


def make_status_model(raw_payload, *, model="STC32G12K128", magic=STC32G12K128_MAGIC,
                      bsl_version=None):
    raw = bytes(raw_payload)
    if magic != STC32G12K128_MAGIC or model != "STC32G12K128":
        raise OfflineProtocolError("offline model currently accepts only STC32G12K128")
    if not raw:
        raise OfflineProtocolError("status payload cannot be empty")
    return StatusModel(model, magic, bsl_version, raw)


def parse_intel_hex(text):
    """Return sparse address->byte data after strict Intel HEX validation."""
    memory = {}
    base = 0
    eof = False
    for line_no, raw_line in enumerate(str(text).splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if eof:
            raise OfflineProtocolError(f"HEX line {line_no}: data after EOF")
        if not line.startswith(":") or len(line[1:]) % 2:
            raise OfflineProtocolError(f"HEX line {line_no}: malformed record")
        try:
            record = bytes.fromhex(line[1:])
        except ValueError as exc:
            raise OfflineProtocolError(f"HEX line {line_no}: non-hex data") from exc
        count = record[0] if record else -1
        if len(record) != count + 5 or sum(record) & 0xFF:
            raise OfflineProtocolError(f"HEX line {line_no}: length or checksum error")
        offset = int.from_bytes(record[1:3], "big")
        kind = record[3]
        data = record[4:4 + count]
        if kind == 0:
            for index, value in enumerate(data):
                address = base + offset + index
                if address in memory:
                    raise OfflineProtocolError(f"HEX line {line_no}: overlapping address")
                memory[address] = value
        elif kind == 1:
            if count != 0 or offset != 0:
                raise OfflineProtocolError(f"HEX line {line_no}: malformed EOF")
            eof = True
        elif kind in (2, 4):
            if count != 2 or offset != 0:
                raise OfflineProtocolError(f"HEX line {line_no}: malformed extended address")
            base = int.from_bytes(data, "big") * (16 if kind == 2 else 0x10000)
        elif kind in (3, 5):
            if count != 4 or offset != 0:
                raise OfflineProtocolError(f"HEX line {line_no}: malformed start address")
        else:
            raise OfflineProtocolError(f"HEX line {line_no}: unsupported record type {kind}")
    if not eof or not memory:
        raise OfflineProtocolError("HEX must contain data and EOF")
    return memory


def prepare_blocks(text, block_size=64):
    """Create sparse, deterministic blocks for offline inspection only."""
    if not isinstance(block_size, int) or not 1 <= block_size <= 1024:
        raise OfflineProtocolError("block_size must be between 1 and 1024")
    memory = parse_intel_hex(text)
    addresses = sorted(memory)
    blocks = []
    start = addresses[0]
    chunk = bytearray([0xFF] * block_size)
    next_address = start
    for address in addresses:
        if address != next_address or address >= start + block_size:
            blocks.append({"address": start, "data": bytes(chunk)})
            start = address
            chunk = bytearray([0xFF] * block_size)
        chunk[address - start] = memory[address]
        next_address = address + 1
    blocks.append({"address": start, "data": bytes(chunk)})
    return {
        "block_size": block_size,
        "bytes": len(memory),
        "min_address": min(addresses),
        "max_address": max(addresses),
        "sha256": hashlib.sha256(bytes(memory[a] for a in addresses)).hexdigest(),
        "blocks": blocks,
        "hardware_write_enabled": False,
    }


def program(*_args, **_kwargs):
    raise ProgrammingDisabled("独立烧录尚未开放：offline_protocol 只允许离线准备和校验")

"""Supported STC flash targets and their protocol-level constraints."""

TARGETS = {
    0xF7E3: {
        "model": "STC32G12K128",
        "family": "stc32-uart",
        "block_size": 64,
        "code_size": 131072,
        "eeprom_supported": True,
        "flash_enabled": True,
        "verification": "hardware-verified",
    },
    # These entries are intentionally identification-only.  Their model
    # metadata is useful for diagnostics, but their erase/write packet
    # details have not been validated on this board and must not be used for
    # programming.
    0xF7E1: {"model": "STC32G12K128-Beta", "family": "stc32-uart", "block_size": 64, "code_size": 131072, "eeprom_supported": False, "flash_enabled": False, "verification": "identify-only"},
    0xF850: {"model": "STC32G8K64-Beta", "family": "stc32-uart", "block_size": 64, "code_size": 65536, "eeprom_supported": False, "flash_enabled": False, "verification": "identify-only"},
    0xF854: {"model": "STC32G8K64", "family": "stc32-uart", "block_size": 64, "code_size": 65536, "eeprom_supported": False, "flash_enabled": False, "verification": "identify-only"},
    0xF871: {"model": "STC32F12K16", "family": "stc32-uart", "block_size": 64, "code_size": 16384, "eeprom_supported": True, "flash_enabled": False, "verification": "identify-only"},
}


def target_for_magic(magic):
    """Return a copy of the registered target, or None when unsupported."""
    target = TARGETS.get(int(magic))
    return dict(target, magic=int(magic)) if target else None


def supported_model(model):
    return any(target["model"] == model for target in TARGETS.values())

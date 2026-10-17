"""Supported STC flash targets and their protocol-level constraints."""

TARGETS = {
    0xF7E3: {
        "model": "STC32G12K128",
        "family": "stc32-uart",
        "block_size": 64,
        "code_size": 131072,
        "eeprom_supported": True,
    },
}


def target_for_magic(magic):
    """Return a copy of the registered target, or None when unsupported."""
    target = TARGETS.get(int(magic))
    return dict(target, magic=int(magic)) if target else None


def supported_model(model):
    return any(target["model"] == model for target in TARGETS.values())

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from protocol_registry import target_for_magic, supported_model


class ProtocolRegistryTests(unittest.TestCase):
    def test_stc32_target_constraints(self):
        target = target_for_magic(0xF7E3)
        self.assertEqual(target["model"], "STC32G12K128")
        self.assertEqual(target["family"], "stc32-uart")
        self.assertEqual(target["block_size"], 64)
        self.assertEqual(target["code_size"], 131072)

    def test_unknown_magic_is_not_supported(self):
        self.assertIsNone(target_for_magic(0x1234))
        self.assertFalse(supported_model("STC8G"))


if __name__ == "__main__":
    unittest.main()

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from offline_protocol import (OfflineProtocolError, ProgrammingDisabled,
                              make_status_model, parse_intel_hex,
                              prepare_blocks, program)


def record(address, data, kind=0):
    body = bytes([len(data), address >> 8, address & 0xff, kind]) + bytes(data)
    checksum = (-sum(body)) & 0xff
    return ':' + (body + bytes([checksum])).hex().upper()


class OfflineProtocolTests(unittest.TestCase):
    def test_status_model_preserves_raw_bytes_and_never_claims_options(self):
        model = make_status_model(b'\x01\x02\x03', bsl_version='7.4.5U')
        self.assertEqual(model.as_dict()['raw_status_payload_hex'], '010203')
        self.assertIsNone(model.as_dict()['configured_eeprom_bytes'])
        self.assertFalse(model.flash_write_performed)

    def test_hex_blocks_are_sparse_and_deterministic(self):
        text = '\n'.join([record(0x10, [0xAA, 0xBB]), record(0x20, [0xCC]), record(0, [], 1)])
        memory = parse_intel_hex(text)
        self.assertEqual(memory, {0x10: 0xAA, 0x11: 0xBB, 0x20: 0xCC})
        prepared = prepare_blocks(text, block_size=4)
        self.assertEqual(prepared['bytes'], 3)
        self.assertEqual([item['address'] for item in prepared['blocks']], [0x10, 0x20])
        self.assertFalse(prepared['hardware_write_enabled'])

    def test_invalid_hex_and_programming_are_blocked(self):
        with self.assertRaises(OfflineProtocolError):
            parse_intel_hex(record(0, [1])[:-2])
        with self.assertRaises(ProgrammingDisabled):
            program(b'anything')


if __name__ == '__main__':
    unittest.main()

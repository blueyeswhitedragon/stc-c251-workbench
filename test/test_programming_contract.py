"""Characterize upstream hazards entirely in memory, never program a device.

These tests document why the extension's flash command MUST remain disabled.
Serial construction is forbidden; packets and replies are synthetic Python bytes.
They are not a firmware programmer and do not establish device-side semantics.
"""
import contextlib
import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python/vendor'))
from stcgal.protocols import Stc8dProtocol, StcProtocolException


class MemoryOnlyProtocol(Stc8dProtocol):
    def __init__(self):
        super().__init__('OFFLINE_NO_DEVICE', 2400, 115200, 0)
        self.bsl_version = 0x74
        self.sent = []
        self.reply_override = None
        self.progress_cb = lambda *args: None

    def connect(self, *args, **kwargs):
        raise AssertionError('Hardware connection is forbidden in these tests')

    def write_packet(self, packet_data, epilogue_len=0):
        self.sent.append(bytes(packet_data))

    def read_packet(self):
        if self.reply_override is not None:
            return self.reply_override
        command = self.sent[-1][0]
        if command in (0x22, 0x02):
            return bytes([0x02, 0x54])
        if command in (0x07, 0x04):
            return bytes([command, 0x54])
        if command == 0x03:
            return bytes([0x03]) + b'FAKEUID'
        raise AssertionError(f'Unexpected offline command: {command}')


class ProgrammingContractTests(unittest.TestCase):
    def setUp(self):
        self.serial_block = patch('serial.Serial', side_effect=AssertionError('Serial access forbidden'))
        self.serial_block.start()
        self.addCleanup(self.serial_block.stop)
        self.protocol = MemoryOnlyProtocol()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_64k_boundary_fits_upstream_offset_field(self):
        self.protocol.program_flash(bytes(65536))
        writes = [p for p in self.protocol.sent if p[0] in (0x22, 0x02)]
        self.assertEqual(len(writes), 65536 // self.protocol.PROGRAM_BLOCKSIZE)
        self.assertEqual(int.from_bytes(writes[-1][1:3], 'big'), 65536 - self.protocol.PROGRAM_BLOCKSIZE)
        self.assertEqual(self.protocol.sent[-1][0], 0x07)

    def test_over_64k_fails_after_64k_was_already_dispatched(self):
        # This is evidence of a host-side late failure, NOT a real partial flash.
        with self.assertRaises(struct.error):
            self.protocol.program_flash(bytes(65537))
        self.assertEqual(len(self.protocol.sent), 65536 // self.protocol.PROGRAM_BLOCKSIZE)
        self.assertNotIn(0x07, [p[0] for p in self.protocol.sent])

    def test_ack_only_responses_are_accepted_without_readback(self):
        # No fake memory or stored firmware exists in this transport.
        self.protocol.program_flash(bytes([0xA5]) * 64)
        self.assertEqual([p[0] for p in self.protocol.sent], [0x22, 0x07])

    def test_bad_ack_is_rejected(self):
        self.protocol.reply_override = bytes([0x02, 0x00])
        with self.assertRaises(StcProtocolException):
            self.protocol.program_flash(bytes(64))

    def test_erase_packet_does_not_encode_small_image_length(self):
        self.protocol.erase_flash(64, 65536)
        small = self.protocol.sent[-1]
        self.protocol.erase_flash(64000, 65536)
        self.assertEqual(small, self.protocol.sent[-1])
        self.assertEqual(small, bytes([0x03, 0x00, 0x00, 0x5A, 0xA5]))
        self.protocol.erase_flash(65537, 65536)
        self.assertEqual(self.protocol.sent[-1], bytes([0x03, 0x01, 0x00, 0x5A, 0xA5]))

    def test_option_builder_fills_more_than_the_five_copied_bytes(self):
        from stcgal.options import Stc8Option
        msr = bytes([0x12, 0x34, 0x56, 0x78, 0x9A])  # synthetic, not a device capture
        self.protocol.options = Stc8Option(msr)
        self.protocol.trim_frequency = 12000000
        self.protocol.trim_value = (0x11, 0x22)
        self.protocol.trim_divider = 2
        packet = self.protocol.build_options()
        self.assertEqual(len(packet), 40)
        self.assertEqual(bytes([packet[32]]) + packet[36:40], msr)
        self.assertEqual(packet[24:28], (12000000).to_bytes(4, 'big'))
        self.assertEqual(packet[28:31], bytes([0x11, 0x22, 2]))
        self.assertEqual([packet[i] for i in (3, 6, 22)], [0, 0, 0])
        self.assertEqual(packet[0:3], b'\xff\xff\xff')


if __name__ == '__main__':
    unittest.main()

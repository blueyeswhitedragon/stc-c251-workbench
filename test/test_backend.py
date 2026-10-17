"""Offline tests of the shipped backend; no physical serial port is opened."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python' / 'vendor'))
sys.path.insert(0, str(ROOT / 'python'))
from probe_core import ReadOnlyProbe, FrameBuffer, ProbeTimeout


def packet(payload):
    body = b'\x68' + (len(payload) + 6).to_bytes(2, 'big') + payload
    return b'\x46\xb9' + body + (sum(body) & 0xffff).to_bytes(2, 'big') + b'\x16'


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.probe = ReadOnlyProbe('NOT_A_PORT', time.monotonic() + 5)

    def test_noise_and_fragmented_frame(self):
        payload = bytes(range(50))
        buf = FrameBuffer(self.probe.extract_payload)
        buf.feed(b'\x3c\x38' * 2000)
        self.assertIsNone(buf.pop())
        data = packet(payload)
        for byte in data[:-1]:
            buf.feed(bytes([byte]))
            self.assertIsNone(buf.pop())
        buf.feed(data[-1:])
        self.assertEqual(buf.pop(), payload)
        self.assertEqual(buf.discarded, 4000)

    def test_corrupt_frame_recovers(self):
        valid = packet(b'abc')
        broken = bytearray(valid)
        broken[-2] ^= 1
        buf = FrameBuffer(self.probe.extract_payload)
        buf.feed(broken + valid)
        self.assertEqual(buf.pop(), b'abc')

    def test_mutating_operations_blocked(self):
        for method in ['handshake', 'calibrate', 'erase_flash', 'program_flash', 'program_options', 'set_option']:
            with self.subTest(method=method), self.assertRaises(RuntimeError):
                getattr(self.probe, method)()
        for value in [b'\x03', b'\x04', b'\x22', b'\x00']:
            with self.assertRaises(RuntimeError):
                self.probe.write_packet(value)
        with self.assertRaises(RuntimeError):
            self.probe.pulse(b'\x00')

    def test_deadline(self):
        self.probe.deadline = time.monotonic() - 1
        with self.assertRaises(ProbeTimeout):
            self.probe.check_deadline()

    def test_cli_check_and_reject_flash(self):
        result = subprocess.run([sys.executable, str(ROOT / 'python/backend.py'), 'check'], capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['flashEnabled'])
        result = subprocess.run([sys.executable, str(ROOT / 'python/backend.py'), 'flash'], capture_output=True)
        self.assertEqual(result.returncode, 2)

    def test_synthetic_status_decodes_without_serial_or_option_claims(self):
        # Construct an artificial packet; never publish a user's device capture.
        payload = bytearray(50)
        payload[0] = 0x50
        payload[1:5] = (12000000).to_bytes(4, 'big')
        payload[17:19] = bytes([0x74, ord('U')])
        payload[20:22] = (0xf7e3).to_bytes(2, 'big')
        payload[22] = 5
        payload[23:25] = (32000).to_bytes(2, 'big')
        payload[35:37] = (1200).to_bytes(2, 'big')
        payload[37:40] = bytes([0x24, 0x01, 0x01])
        payload = bytes(payload)
        self.probe.pending = payload
        # initialize() only decodes the status already received by connect().
        from stcgal.models import MCUModelDatabase
        self.probe.mcu_magic = 0xf7e3
        self.probe.model = MCUModelDatabase.find_model(self.probe.mcu_magic)
        self.probe.status_packet = payload
        with contextlib.redirect_stdout(io.StringIO()):
            self.probe.initialize()
        info = self.probe.snapshot()
        self.assertEqual(info['model'], 'STC32G12K128')
        self.assertEqual(info['bsl_version'], '7.4.5U')
        self.assertIsNone(info['reset_pin_enabled'])
        self.assertIsNone(info['configured_eeprom_bytes'])
        self.assertFalse(info['flash_write_performed'])


if __name__ == '__main__':
    unittest.main()

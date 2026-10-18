"""Offline response timing and erase failure injection; never opens a port."""
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python/vendor'))
sys.path.insert(0, str(ROOT / 'python'))
import serial
import backend
from flash_diagnostics import FlashDiagnostics, read_exact
from probe_core import ReadOnlyProbe
from stcgal.protocols import Stc8dProtocol, Stc15Protocol


class FlashDiagnosticTests(unittest.TestCase):
    def test_response_deadline_and_partial_rx(self):
        events = []
        diag = FlashDiagnostics(lambda kind, **kw: events.append(kw), 30)
        diag.stage = 'erase'
        connection = SimpleNamespace(timeout=0.25, read=lambda n: b'\x46')
        with patch('flash_diagnostics.time.monotonic', side_effect=[100, 100, 103]):
            with self.assertRaises(serial.SerialTimeoutException):
                read_exact(connection, 2, 102, diag)
        with patch('flash_diagnostics.time.monotonic', return_value=100):
            with self.assertRaises(serial.SerialTimeoutException):
                read_exact(connection, 1, 99, diag)
        self.assertIn('46', events[-1]['message'])

    def test_empty_reads_and_fragmentation_wait_with_one_deadline(self):
        diag = FlashDiagnostics(lambda *a, **k: None)
        chunks = iter([b'', b'\x46', b'', b'\xb9'])
        connection = SimpleNamespace(timeout=0.25, read=lambda n: next(chunks))
        with patch('flash_diagnostics.time.monotonic', return_value=100), patch('flash_diagnostics.time.sleep'):
            self.assertEqual(read_exact(connection, 2, 115, diag), b'\x46\xb9')
        self.assertEqual(connection.timeout, 0.25)

    def test_empty_read_cannot_extend_response_deadline(self):
        diag = FlashDiagnostics(lambda *a, **k: None)
        connection = SimpleNamespace(timeout=0.25, read=lambda n: b'')
        with patch('flash_diagnostics.time.monotonic', side_effect=[100, 101, 115]), patch('flash_diagnostics.time.sleep'):
            with self.assertRaisesRegex(serial.SerialTimeoutException, 'deadline exceeded'):
                read_exact(connection, 1, 115, diag)

    def test_closed_port_does_not_wait_for_deadline(self):
        diag = FlashDiagnostics(lambda *a, **k: None)
        connection = SimpleNamespace(timeout=0.25, is_open=False, read=lambda n: b'')
        with patch('flash_diagnostics.time.monotonic', return_value=100):
            with self.assertRaises(serial.SerialException):
                read_exact(connection, 1, 115, diag)

    def test_phase_limits_and_firmware_not_logged(self):
        events = []
        diag = FlashDiagnostics(lambda kind, **kw: events.append(kw), 45)
        connection = SimpleNamespace(timeout=0)
        for phase, limit in [('handshake', 15), ('erase', 45), ('write', 5), ('finish', 5)]:
            diag.enter(phase, connection)
            self.assertEqual(diag.timeout, limit)
            self.assertEqual(connection.timeout, 0.25)
        before = len(events)
        diag.control('TX', b'private-firmware')
        self.assertEqual(len(events), before)

    def test_timeout_classification(self):
        diag = FlashDiagnostics(lambda *a, **k: None)
        self.assertEqual(diag.failure(True)[0], 'res_timeout')
        diag.enter('erase', SimpleNamespace(timeout=0))
        diag.may_have_erased = True
        code, message = diag.failure(True)
        self.assertEqual(code, 'erase_timeout')
        self.assertIn('状态未知', message)
        self.assertNotIn('未擦写', message)

    def test_erase_timeout_never_retries_and_closes_both_bsl_versions(self):
        for version in ('7.4.5U', '7.4.13U'):
            state = {'erase': 0, 'closed': False}
            output = io.StringIO()

            def connect(probe, autoreset=False):
                def close():
                    state['closed'] = True
                    probe.ser.is_open = False
                probe.ser = SimpleNamespace(is_open=True, timeout=0, close=close)
                probe.mcu_magic = 0xF7E3
                probe.model = SimpleNamespace(name='STC32G12K128')
                probe.mcu_bsl_version = version
                probe.mcu_clock_hz = 11057000

            def erase(probe, *args):
                state['erase'] += 1
                probe.write_packet(b'\x03\x00\x00\x5a\xa5')
                raise serial.SerialTimeoutException('synthetic erase timeout')

            with patch.object(backend, 'WIRE', output), \
                 patch.object(backend, 'load_stc32_hex', return_value=(b'\x01', 'synthetic', 1)), \
                 patch.object(ReadOnlyProbe, 'connect', connect), \
                 patch.object(ReadOnlyProbe, 'initialize', lambda p: None), \
                 patch.object(Stc8dProtocol, 'calibrate', lambda p: None), \
                 patch.object(Stc15Protocol, 'write_packet', lambda *a: None), \
                 patch.object(Stc15Protocol, 'read_packet', lambda p: b'\x05'), \
                 patch.object(Stc15Protocol, 'erase_flash', erase):
                code = backend.flash_device('SIMULATED', 'SIMULATED.hex', 10)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(code, 2)
            self.assertEqual(state['erase'], 1)
            self.assertTrue(state['closed'])
            error = next(e for e in events if e['event'] == 'error')
            self.assertEqual(error['code'], 'erase_timeout')
            self.assertIn('状态未知', error['message'])
            self.assertNotIn('flashed', [e['event'] for e in events])


if __name__ == '__main__':
    unittest.main()

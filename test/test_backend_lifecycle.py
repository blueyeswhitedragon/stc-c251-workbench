"""Backend lifecycle fault injection; no serial device is opened."""
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
import backend
from probe_core import ProbeTimeout
import serial


class LifecycleTests(unittest.TestCase):
    def attempt(self, fault=None):
        state = {'closes': 0, 'disconnects': 0, 'initialized': False}

        class Connection:
            is_open = True

            def close(self):
                state['closes'] += 1
                if fault == 'close':
                    raise serial.SerialException('simulated close error')
                self.is_open = False

        class FakeProbe:
            def __init__(self, port, deadline):
                self.deadline = deadline
                self.ser = Connection()
                self.mcu_magic = 0xf7e1 if fault == 'unsupported' else 0xf7e3
                self.model = SimpleNamespace(name='synthetic')

            def connect(self, autoreset):
                assert autoreset is False
                if fault == 'busy':
                    raise serial.SerialException('simulated port busy')
                self.pulse()

            def pulse(self):
                if fault == 'timeout':
                    raise ProbeTimeout()
                if fault == 'unplug':
                    raise serial.SerialException('simulated cable disconnected')

            def initialize(self):
                if fault == 'malformed':
                    raise ValueError('simulated invalid status')
                state['initialized'] = True

            def snapshot(self):
                return {'model': 'STC32G12K128', 'flash_write_performed': False}

            def disconnect(self):
                state['disconnects'] += 1
                if fault == 'disconnect':
                    raise serial.SerialException('simulated disconnect error')

        output = io.StringIO()
        with patch.object(backend, 'WIRE', output):
            code = backend.identify_device('SIMULATED', 10, FakeProbe)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        return code, events, state

    def test_success_only_after_close(self):
        code, events, state = self.attempt()
        self.assertEqual(code, 0)
        self.assertEqual([e['event'] for e in events], ['opening','waiting','reading','closed','identified'])
        self.assertTrue(events[-2]['released'])
        self.assertEqual(state['closes'], 1)
        self.assertEqual(state['disconnects'], 1)
        self.assertFalse(events[-1]['snapshot']['flash_write_performed'])

    def test_timeout_closes_port_and_retry_succeeds(self):
        code, events, state = self.attempt('timeout')
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]['code'], 'timeout')
        self.assertEqual(state['closes'], 1)
        self.assertNotIn('identified', [e['event'] for e in events])
        self.assertEqual(self.attempt()[0], 0)

    def test_busy_does_not_prompt_res(self):
        code, events, state = self.attempt('busy')
        self.assertEqual(code, 3)
        self.assertNotIn('waiting', [e['event'] for e in events])
        self.assertEqual(events[-1]['code'], 'serial_unavailable')
        self.assertEqual(state['closes'], 1)

    def test_unplug_closes_handle_and_reconnect_can_retry(self):
        code, events, state = self.attempt('unplug')
        self.assertEqual(code, 3)
        self.assertEqual(events[-1]['code'], 'serial_unavailable')
        self.assertEqual(state['closes'], 1)
        self.assertEqual(self.attempt()[0], 0)

    def test_unsupported_chip_never_initializes(self):
        code, events, state = self.attempt('unsupported')
        self.assertEqual(code, 3)
        self.assertEqual(events[-1]['code'], 'unsupported_chip')
        self.assertFalse(state['initialized'])
        self.assertEqual(state['disconnects'], 1)
        self.assertEqual(state['closes'], 1)

    def test_malformed_status_closes_port(self):
        code, events, state = self.attempt('malformed')
        self.assertEqual(code, 3)
        self.assertEqual(events[-1]['code'], 'identify_failed')
        self.assertEqual(state['closes'], 1)

    def test_close_failure_never_reports_success(self):
        code, events, state = self.attempt('close')
        self.assertEqual(code, 3)
        self.assertEqual(events[-1]['code'], 'close_failed')
        self.assertFalse(events[-2]['released'])
        self.assertNotIn('identified', [e['event'] for e in events])

    def test_disconnect_failure_still_closes_port(self):
        code, events, state = self.attempt('disconnect')
        self.assertEqual(code, 3)
        self.assertEqual(state['closes'], 1)
        self.assertNotIn('identified', [e['event'] for e in events])


if __name__ == '__main__':
    unittest.main()

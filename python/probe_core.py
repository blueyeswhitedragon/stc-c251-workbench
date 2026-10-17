"""Bounded STC8D/STC32 identification only; never erase/program/calibrate."""

import argparse
import contextlib
from datetime import datetime
import json
from pathlib import Path
import sys
import time

import serial
from stcgal.protocols import Stc8dProtocol, StcProtocolException, StcFramingException


class ProbeTimeout(Exception):
    pass


class FrameBuffer:
    """Resynchronize noisy STC input without dropping a valid trailing frame."""

    def __init__(self, validate):
        self.data = bytearray()
        self.validate = validate
        self.discarded = 0

    def feed(self, data):
        self.data.extend(data)

    def pop(self):
        while self.data:
            if self.data.startswith(b"\x46\xb9\x68"):
                prefix = b""
                header_size = 5
            elif self.data[0] == 0x68:
                prefix = b"\x46\xb9"
                header_size = 3
            elif bytes(self.data) in (b"\x46", b"\x46\xb9"):
                return None
            else:
                del self.data[0]
                self.discarded += 1
                continue
            if len(self.data) < header_size:
                return None
            length = int.from_bytes(self.data[header_size - 2:header_size], "big")
            if not 6 <= length <= 512:
                del self.data[0]
                self.discarded += 1
                continue
            total = header_size + length - 3
            if len(self.data) < total:
                return None
            frame = prefix + bytes(self.data[:total])
            try:
                payload = self.validate(frame)
            except StcFramingException:
                del self.data[0]
                self.discarded += 1
                continue
            del self.data[:total]
            return payload
        return None


class ReadOnlyProbe(Stc8dProtocol):
    def __init__(self, port, deadline):
        super().__init__(port, 2400, 115200, 0)
        self.deadline = deadline
        self.received = 0
        self.frames = FrameBuffer(self.extract_payload)
        self.pending = None
        self.next_report = time.monotonic() + 5

    def check_deadline(self):
        if time.monotonic() >= self.deadline:
            raise ProbeTimeout()

    def pulse(self, character=b"\x7f", timeout=0):
        # Only the upstream identification sync byte is permitted.
        if character != b"\x7f":
            raise RuntimeError("Non-identification pulse blocked")
        while True:
            self.check_deadline()
            self.ser.write(character)
            self.ser.flush()
            time.sleep(0.03)
            available = min(self.ser.in_waiting, 4096)
            if available:
                data = self.ser.read(available)
                self.received += len(data)
                self.frames.feed(data)
            self.pending = self.frames.pop()
            if self.pending is not None:
                print(f"\nVALID_FRAME: {len(self.pending)} payload bytes", flush=True)
                return
            if time.monotonic() >= self.next_report:
                print(f"\nWAITING: received={self.received}, discarded_noise={self.frames.discarded}, buffered={len(self.frames.data)}", flush=True)
                self.next_report = time.monotonic() + 5

    def read_packet(self):
        if self.pending is None:
            self.pulse()
        payload = self.pending
        self.pending = None
        return payload

    def initialize_options(self, status_packet):
        if self.model.mcs251:
            # STC8's option schema is not established for STC32; do not present
            # reset_pin_enabled=False or EEPROM=0 as verified device settings.
            self.options = None
            print("STC32 hardware options: UNVERIFIED; preserving complete raw status only.")
            return
        super().initialize_options(status_packet)

    def print_mcu_info(self):
        if not self.model.mcs251:
            return super().print_mcu_info()
        print(f"Target model: {self.model.name}")
        print(f"Magic: {self.mcu_magic:04X}")
        print(f"Model-table total flash: {self.model.total} bytes (not a partition measurement)")
        print("Configured EEPROM size: UNKNOWN (do not use model-table defaults)")
        print(f"Target frequency: {self.mcu_clock_hz / 1E6:.3f} MHz")
        print(f"Target BSL version: {self.mcu_bsl_version}")
        print(f"Target wakeup frequency: {self.wakeup_freq / 1000:.3f} KHz")
        print(f"Target ref. voltage: {self.reference_voltage} mV")
        print("Target mfg. date: %04d-%02d-%02d" % self.mfg_date)

    def snapshot(self):
        return {
            "schema_version": 1,
            "captured_at": datetime.now().astimezone().isoformat(),
            "port": self.port,
            "model": self.model.name,
            "model_magic": f"0x{self.mcu_magic:04X}",
            "bsl_version": self.mcu_bsl_version,
            "clock_hz": self.mcu_clock_hz,
            "reference_voltage_mv": self.reference_voltage,
            "manufacturing_date": list(self.mfg_date),
            "raw_status_payload_hex": self.status_packet.hex(),
            "raw_status_payload_bytes": len(self.status_packet),
            "hardware_options_trust": "unverified_for_stc32",
            "reset_pin_enabled": None,
            "configured_eeprom_bytes": None,
            "flash_write_performed": False,
            "note": "This status capture is not a flash/EEPROM backup and cannot establish a safe option-write packet.",
        }

    def write_packet(self, packet_data, epilogue_len=0):
        if packet_data != b"\xff" or epilogue_len:
            raise RuntimeError("Only STC8/STC32 disconnect is permitted by this probe")
        return super().write_packet(packet_data, epilogue_len)

    def read_bytes_safe(self, num):
        self.check_deadline()
        if not 0 <= num <= 512:
            raise StcProtocolException("Invalid identification frame length")
        data = super().read_bytes_safe(num)
        self.received += len(data)
        return data

    def blocked(self, *args, **kwargs):
        raise RuntimeError("Programming operation blocked in read-only probe")

    handshake = blocked
    calibrate = blocked
    erase_flash = blocked
    program_flash = blocked
    program_options = blocked
    set_option = blocked


class Tee:
    def __init__(self, terminal, logfile):
        self.terminal = terminal
        self.logfile = logfile

    def write(self, text):
        self.terminal.write(text)
        self.logfile.write(text)
        self.flush()
        return len(text)

    def flush(self):
        self.terminal.flush()
        self.logfile.flush()


def probe(port, seconds, snapshot_path=None):
    deadline = time.monotonic() + seconds
    print(f"READ-ONLY IDENTIFICATION: {port}; deadline={seconds}s", flush=True)
    print("No HEX file, erase, option write, calibration or automatic reset.")
    last_error = None
    while time.monotonic() < deadline:
        device = ReadOnlyProbe(port, deadline)
        try:
            device.connect(autoreset=False)
            device.initialize()
            if snapshot_path:
                with snapshot_path.open("x", encoding="utf-8") as output:
                    json.dump(device.snapshot(), output, ensure_ascii=False, indent=2)
                    output.write("\n")
                print(f"RAW_STATUS_SAVED: {snapshot_path}")
            device.disconnect()
            print("IDENTIFICATION_OK (does not verify flash programming)")
            return 0
        except ProbeTimeout:
            print(f"\nTIMEOUT: no valid identification; received_bytes={device.received}")
            return 2
        except serial.SerialException as error:
            message = str(error)
            if message != last_error:
                print(f"\nPORT_UNAVAILABLE: {message}; waiting for {port} to reconnect.")
                last_error = message
        except StcProtocolException as error:
            print(f"\nPROTOCOL_ERROR: {error}; no flash operation performed.")
            return 3
        finally:
            connection = getattr(device, "ser", None)
            if connection is not None and connection.is_open:
                connection.close()
        time.sleep(0.5)
    print("TIMEOUT: port not available before deadline.")
    return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="COM20")
    parser.add_argument("--seconds", type=int, choices=range(10, 301), default=180)
    args = parser.parse_args()
    log = Path(__file__).parent / f"probe-{datetime.now():%Y%m%d-%H%M%S-%f}.log"
    print(f"Log: {log}")
    with log.open("x", encoding="utf-8") as output:
        with contextlib.redirect_stdout(Tee(sys.stdout, output)):
            with contextlib.redirect_stderr(Tee(sys.stderr, output)):
                try:
                    return probe(args.port, args.seconds, log.with_suffix(".json"))
                except KeyboardInterrupt:
                    print("\nCANCELLED: serial port released.")
                    return 130


if __name__ == "__main__":
    raise SystemExit(main())

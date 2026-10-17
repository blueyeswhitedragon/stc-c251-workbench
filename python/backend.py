"""JSON-line interface for STC32 identification and programming."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
import time
import hashlib

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
WIRE = sys.stdout


def load_stc32_hex(filename):
    """Load Intel HEX into the STC32 code address window.

    STC32 HEX files use the 24-bit FFxxxx code address.  The BSL write
    command addresses that window from zero, so the returned image is a
    dense, 128 KiB-safe image with erased bytes filled as 0xff.
    """
    memory = {}
    base = 0
    eof = False
    raw_file = Path(filename).read_bytes()
    for line_no, raw in enumerate(raw_file.decode('ascii').splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if eof:
            raise ValueError(f"HEX 第 {line_no} 行位于 EOF 之后")
        if not line.startswith(':') or len(line[1:]) % 2:
            raise ValueError(f"HEX 第 {line_no} 行格式错误")
        record = bytes.fromhex(line[1:])
        if len(record) < 5 or len(record) != record[0] + 5 or sum(record) & 0xff:
            raise ValueError(f"HEX 第 {line_no} 行长度或校验和错误")
        count, offset, kind = record[0], int.from_bytes(record[1:3], 'big'), record[3]
        if kind == 0:
            if offset + count > 0x10000:
                raise ValueError(f"HEX 第 {line_no} 行跨越 64 KiB 边界")
            for index, value in enumerate(record[4:4 + count]):
                address = base + offset + index
                if address in memory:
                    raise ValueError(f"HEX 第 {line_no} 行地址重叠")
                memory[address] = value
        elif kind == 1:
            if count or offset:
                raise ValueError(f"HEX 第 {line_no} 行 EOF 格式错误")
            eof = True
        elif kind == 4:
            if count != 2 or offset:
                raise ValueError(f"HEX 第 {line_no} 行扩展地址格式错误")
            base = int.from_bytes(record[4:6], 'big') << 16
        elif kind in (2, 3, 5):
            # Segment/start-address records are irrelevant to programming.
            continue
        else:
            raise ValueError(f"HEX 第 {line_no} 行记录类型不支持")
    if not eof or not memory:
        raise ValueError('HEX 缺少 EOF 或程序数据')
    outside = [a for a in memory if not (0xfe0000 <= a <= 0xffffff)]
    eeprom = [a for a in memory if 0xfe0000 <= a < 0xff0000]
    code = [a for a in memory if 0xff0000 <= a <= 0xffffff]
    if outside:
        raise ValueError(f'HEX 含 STC32 不支持地址（{len(outside)} 字节）')
    if eeprom:
        raise ValueError('当前独立后端不写入 EEPROM 区；请只选择代码 HEX')
    if not code:
        raise ValueError('HEX 没有 STC32 代码区数据')
    highest = max(code) - 0xff0000 + 1
    image = bytearray([0xff]) * highest
    for address, value in memory.items():
        image[address - 0xff0000] = value
    return bytes(image), hashlib.sha256(raw_file).hexdigest(), len(code)


def emit(kind, **values):
    WIRE.write(json.dumps({"event": kind, **values}, ensure_ascii=False) + "\n")
    WIRE.flush()


class EventLog(io.TextIOBase):
    def __init__(self):
        self.pending = ""

    def write(self, text):
        self.pending += text
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if line.strip():
                emit("log", message=line.rstrip())
        return len(text)

    def flush(self):
        if self.pending:
            emit("log", message=self.pending)
            self.pending = ""


def identify_device(port, seconds, probe_type=None):
    """One bounded attempt; emit success only after the serial handle is closed."""
    import serial
    from probe_core import ReadOnlyProbe, ProbeTimeout

    class InteractiveProbe(probe_type or ReadOnlyProbe):
        announced = False

        def pulse(self, *a, **kw):
            if not self.announced:
                emit("waiting", port=port, seconds=max(0, self.deadline - time.monotonic()),
                     message="串口已打开，请现在按一下 RES，无需反复按键。")
                self.announced = True
            result = super().pulse(*a, **kw)
            emit("reading", port=port, message="已收到有效响应，正在读取芯片信息；无需再按 RES。")
            return result

    probe = None
    log = EventLog()
    snapshot = None
    failure = None
    exit_code = 0
    emit("opening", port=port, message="正在打开串口，请先不要按 RES。")
    try:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            probe = InteractiveProbe(port, time.monotonic() + seconds)
            probe.connect(autoreset=False)
            if probe.mcu_magic != 0xf7e3:
                failure = ("unsupported_chip", f"当前只验证 STC32G12K128，检测到 {probe.model.name} / {probe.mcu_magic:04X}；未擦写。")
                exit_code = 3
            else:
                probe.initialize()
                snapshot = probe.snapshot()
            probe.disconnect()
    except ProbeTimeout:
        failure = ("timeout", "等待 RES 超时，未擦写。请重新点击识别，等提示后再按 RES。")
        exit_code = 2
    except serial.SerialException as error:
        failure = ("serial_unavailable", f"串口被占用、已断开或不可用。请关闭其他串口工具，重新连接并选择串口后重试。{error}")
        exit_code = 3
    except Exception as error:
        failure = ("identify_failed", f"识别失败（未擦写）：{error}。请重新识别；如板子停在下载模式，可按 RES。")
        exit_code = 3
    finally:
        log.flush()
        connection = getattr(probe, "ser", None)
        try:
            if connection is not None and connection.is_open:
                connection.close()
            emit("closed", port=port, released=True)
        except Exception as error:
            emit("closed", port=port, released=False)
            failure = ("close_failed", f"串口关闭失败，未确认释放：{error}。等待操作结束后重新连接开发板。")
            exit_code = 3
    if failure:
        emit("error", code=failure[0], message=failure[1])
    elif snapshot is not None:
        emit("identified", snapshot=snapshot)
    return exit_code


def flash_device(port, filename, seconds=180):
    """Program STC32G12K128 directly over the CH340 serial bootloader."""
    import serial
    from probe_core import ReadOnlyProbe, ProbeTimeout
    from stcgal.protocols import StcProtocolException

    image, digest, code_bytes = load_stc32_hex(filename)

    class FlashProbe(ReadOnlyProbe):
        # ReadOnlyProbe aliases these methods to ``blocked`` at class
        # definition time.  Rebind the proven STC8/32 implementations only
        # in this explicit flash command; identification remains read-only.
        from stcgal.protocols import Stc8dProtocol, Stc15Protocol
        def handshake(self):
            """Unlock STC32 BSL at its already verified 115200 baud.

            The STC32G12K128 board reports a stable 11.064 MHz clock and
            accepts the normal BSL unlock packet at 115200.  The older
            STC8D trim-search routine is not applicable to this MCS-251
            target and can return an empty calibration range.
            """
            # UART programming requires the STC32 IRC calibration exchange;
            # a zero-filled 0x01 packet may acknowledge but leaves the target
            # at an unusable transfer timing for erase/write commands.
            self.trim_frequency = self.mcu_clock_hz or 11064000
            print(f'STC32: calibrating at {self.trim_frequency} Hz')
            self.Stc8dProtocol.calibrate(self)
            print('STC32: calibration complete')
            packet = bytes([0x05, 0x00, 0x00, 0x5a, 0xa5])
            self.write_packet(packet)
            print('STC32: prepare sent')
            try:
                response = self.read_packet()
            except Exception as first_error:
                # A few 7.4.x STC32 bootloaders accept the legacy short
                # prepare packet even though the extended form is documented.
                # Retry once before reporting a hard serial failure.
                print(f'STC32: extended prepare timeout ({first_error}); retrying short form')
                self.ser.reset_input_buffer()
                self.write_packet(bytes([0x05]))
                try:
                    response = self.read_packet()
                except Exception as second_error:
                    # Some STC32G12K128 BSL builds do not implement 0x05 at
                    # all.  The erase command is authoritative; continue to
                    # it rather than leaving the device in a half-open state.
                    print(f'STC32: short prepare timeout ({second_error}); continuing without 0x05')
                    return
            print(f'STC32: prepare response {response.hex()}')
            if response and response[0] == 0x0f:
                raise StcProtocolException('芯片被下载口令锁定')
            if not response or response[0] != 0x05:
                raise StcProtocolException('STC32 解锁握手响应错误')
            print('Initializing: done')
        calibrate = Stc8dProtocol.calibrate
        # STC32 UART uses the STC15/STC32 16-bit checksum command set.  The
        # read-only probe inherits STC8D only for its status decoder, so bind
        # the actual programming operations from the STC15 implementation.
        erase_flash = Stc15Protocol.erase_flash
        program_flash = Stc15Protocol.program_flash
        program_options = Stc15Protocol.program_options
        PROGRAM_BLOCKSIZE = 64

        # Use the protocol's paired pulse/read implementation.  The
        # identification probe's buffered read sends a sync byte when no
        # frame is pending, which is invalid after an erase/write command.
        pulse = Stc8dProtocol.pulse

        def write_packet(self, packet_data, epilogue_len=0):
            # STC32 UART uses the STC15 frame: length=payload+5 and a
            # one-byte additive checksum followed by 0x16.
            return self.Stc15Protocol.write_packet(self, packet_data, epilogue_len)

        def read_packet(self):
            return self.Stc15Protocol.read_packet(self)

    deadline = time.monotonic() + seconds
    probe = None
    log = EventLog()
    emit('opening', port=port, message='正在打开串口，请现在按一下开发板 RES。')
    emit('waiting', port=port, seconds=seconds, message='串口已打开，请按一下 RES；检测到芯片后将自动擦除并下载。')
    try:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            probe = FlashProbe(port, deadline)
            probe.connect(autoreset=False)
            probe.initialize()
            if probe.mcu_magic != 0xf7e3 or probe.model.name != 'STC32G12K128':
                raise StcProtocolException(f'检测到 {probe.model.name}（Magic 0x{probe.mcu_magic:04X}），不是已验证的 STC32G12K128')
            emit('identified', model=probe.model.name, magic='0xF7E3', bsl=probe.mcu_bsl_version)
            emit('erasing', message='芯片已识别，正在擦除代码区。')
            probe.handshake()
            probe.erase_flash(len(image), probe.model.code)
            emit('writing', total=len(image), sha256=digest, codeBytes=code_bytes)
            probe.progress_cb = lambda done, step, total: emit('progress', done=min(done, total), total=total)
            probe.program_flash(image)
            emit('verified', message='BSL 已确认每个写入块；写入完成包已确认。')
            probe.disconnect()
        emit('flashed', port=port, model='STC32G12K128', sha256=digest, bytes=code_bytes)
        return 0
    except ProbeTimeout:
        emit('error', code='timeout', message='等待 RES 超时，未擦写。请重新点击烧录后再按 RES。')
        return 2
    except serial.SerialException as error:
        emit('error', code='serial_unavailable', message=f'串口不可用或被占用：{error}')
        return 3
    except Exception as error:
        emit('error', code='flash_failed', message=f'独立烧录失败，设备可能未被完整写入：{error}')
        return 3
    finally:
        log.flush()
        connection = getattr(probe, 'ser', None)
        try:
            if connection is not None and connection.is_open:
                connection.close()
            emit('closed', port=port, released=True)
        except Exception as error:
            emit('closed', port=port, released=False)
            emit('error', code='close_failed', message=f'串口释放失败：{error}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("ports")
    identify = sub.add_parser("identify")
    identify.add_argument("--port", required=True)
    identify.add_argument("--seconds", type=int, choices=range(10, 301), default=180)
    flash = sub.add_parser("flash")
    flash.add_argument("--port", required=True)
    flash.add_argument("--hex", required=True)
    flash.add_argument("--seconds", type=int, choices=range(10, 301), default=180)
    args = parser.parse_args()
    try:
        import serial
        from serial.tools import list_ports
        from probe_core import ReadOnlyProbe, ProbeTimeout
    except ImportError as error:
        emit("error", code="missing_dependency", message=f"缺少 Python 依赖，请运行 STC: 配置芯片识别环境。{error}")
        return 4
    if args.command == "check":
        emit("ready", python=sys.version.split()[0], flashEnabled=False)
        return 0
    if args.command == "ports":
        emit("ports", ports=[{"port": p.device, "description": p.description, "vid": p.vid, "pid": p.pid} for p in list_ports.comports()])
        return 0

    if args.command == "flash":
        try:
            return flash_device(args.port, args.hex, args.seconds)
        except (OSError, ValueError) as error:
            emit('error', code='hex_invalid', message=str(error))
            return 3

    return identify_device(args.port, args.seconds)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())

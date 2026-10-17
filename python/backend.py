"""JSON-line interface with no erase/program/calibrate commands."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
WIRE = sys.stdout


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("ports")
    identify = sub.add_parser("identify")
    identify.add_argument("--port", required=True)
    identify.add_argument("--seconds", type=int, choices=range(10, 301), default=180)
    args = parser.parse_args()
    try:
        import serial
        from serial.tools import list_ports
        from probe_core import ReadOnlyProbe, ProbeTimeout
    except ImportError as error:
        emit("error", message=f"缺少 Python 依赖，请运行 STC: 配置芯片识别环境。{error}")
        return 4
    if args.command == "check":
        emit("ready", python=sys.version.split()[0], flashEnabled=False)
        return 0
    if args.command == "ports":
        emit("ports", ports=[{"port": p.device, "description": p.description, "vid": p.vid, "pid": p.pid} for p in list_ports.comports()])
        return 0

    class InteractiveProbe(ReadOnlyProbe):
        announced = False

        def pulse(self, *a, **kw):
            if not self.announced:
                emit("waiting", port=args.port, message="串口已打开，请按一下 RES（不需要拔插 USB）。")
                self.announced = True
            return super().pulse(*a, **kw)

    probe = InteractiveProbe(args.port, time.monotonic() + args.seconds)
    log = EventLog()
    try:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            probe.connect(autoreset=False)
            if probe.mcu_magic not in (0xf7e3, 0xf7e1):
                raise ValueError(f"本 MVP 未验证此芯片：{probe.model.name} / {probe.mcu_magic:04X}")
            probe.initialize()
            snapshot = probe.snapshot()
            probe.disconnect()
        log.flush()
        emit("identified", snapshot=snapshot)
        return 0
    except ProbeTimeout:
        emit("error", message="等待 RES 超时；没有擦写程序。请保持连接并重新执行识别。")
        return 2
    except serial.SerialException as error:
        emit("error", message=f"串口不可用：请关闭 STC-ISP/其他串口工具，确认端口仍连接。{error}")
        return 3
    except Exception as error:
        emit("error", message=f"识别失败（未擦写）：{error}")
        return 3
    finally:
        log.flush()
        connection = getattr(probe, "ser", None)
        if connection is not None and connection.is_open:
            connection.close()


if __name__ == "__main__":
    raise SystemExit(main())

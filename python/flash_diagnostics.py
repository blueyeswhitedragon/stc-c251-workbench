"""Bounded flash response timing and local control-packet diagnostics."""
import time
import serial


class FlashDiagnostics:
    def __init__(self, emit, erase_timeout=30):
        self.emit = emit
        self.erase_timeout = erase_timeout
        self.stage = 'waiting'
        self.timeout = 0.5
        self.may_have_erased = False
        self.started = time.monotonic()

    def enter(self, stage, connection):
        self.stage = stage
        self.started = time.monotonic()
        self.timeout = {'handshake': 15, 'erase': self.erase_timeout,
                        'write': 5, 'finish': 5}.get(stage, 15)
        # Keep the driver's read timeout stable across frame fragments.
        # On Windows a timeout assignment reconfigures the serial device.
        # The response deadline below, not a single read(), owns the budget.
        connection.timeout = 0.25
        self.emit('stage', stage=stage, timeout=self.timeout,
                  message=f'烧录阶段：{stage}；单次响应上限 {self.timeout} 秒。')

    def control(self, direction, data):
        # Never include firmware data in diagnostic output.
        if self.stage in ('handshake', 'erase'):
            self.emit('diagnostic', stage=self.stage, direction=direction,
                      elapsed=round(time.monotonic() - self.started, 3),
                      message=f'ISP {self.stage} {direction}: {data[:64].hex(" ")}'
                              f' ({len(data)} bytes)')

    def failure(self, timeout=False):
        state = '代码区状态未知，可能已擦除或部分写入' if self.may_have_erased else '尚未发送擦除命令'
        if timeout and self.stage == 'waiting':
            return 'res_timeout', '等待芯片响应超时，未发送擦除命令；请检查连接或复位方式。'
        reason = '等待响应超时' if timeout else '通信失败'
        return (f'{self.stage}_timeout' if timeout else 'serial_unavailable',
                f'{self.stage} 阶段{reason}（已用 {time.monotonic() - self.started:.2f} 秒）；'
                f'{state}。操作结束后检查连接并重新烧录；不会自动重发擦除。')


def read_exact(connection, count, deadline, diagnostics):
    """Use one deadline for the entire response, not one timeout per byte."""
    data = bytearray()
    while len(data) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise serial.SerialTimeoutException(f'response deadline exceeded ({len(data)}/{count} bytes)')
        # Only shorten the final blocking read, never reset the deadline or
        # change the driver configuration after every byte.
        if connection.timeout is None or connection.timeout > remaining:
            connection.timeout = remaining
        chunk = connection.read(count - len(data))
        if chunk:
            diagnostics.control('RX', chunk)
            data.extend(chunk)
        else:
            if getattr(connection, 'is_open', True) is False:
                raise serial.SerialException('serial port closed during response')
            time.sleep(min(0.01, remaining))
    return bytes(data)

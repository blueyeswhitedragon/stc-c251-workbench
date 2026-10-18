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
        connection.timeout = self.timeout
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
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise serial.SerialTimeoutException('response deadline exceeded')
    connection.timeout = remaining
    data = connection.read(count)
    diagnostics.control('RX', data)
    if len(data) != count:
        raise serial.SerialTimeoutException(f'read timeout ({len(data)}/{count} bytes)')
    return data

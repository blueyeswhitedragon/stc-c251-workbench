'use strict';
const { spawn } = require('node:child_process');

class CancelledError extends Error { constructor(message = '操作已取消') { super(message); this.name = 'CancelledError'; } }
function launch(executable, args, { cwd, env, timeout = 30000, onStdout, onStderr, token } = {}) {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) return reject(new CancelledError());
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true });
    let stopReason; let stopped = false; let killer; let stdout = []; let stderr = []; let size = 0;
    const stop = message => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = true; stopReason = message;
      if (!child.pid) return;
      // Only this invocation's owned process tree is targeted; never image names.
      if (process.platform === 'win32') {
        killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code) child.kill(); });
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('操作超时，已停止子进程'), timeout);
    const cancel = token?.onCancellationRequested(() => stop('操作已取消'));
    const collect = (dest, callback, data) => {
      size += data.length;
      if (size > 16 * 1024 * 1024) return stop('输出超过安全上限');
      dest.push(data); callback?.(data);
    };
    child.stdout.on('data', data => collect(stdout, onStdout, data));
    child.stderr.on('data', data => collect(stderr, onStderr, data));
    const clean = () => { clearTimeout(timer); cancel?.dispose(); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => {
      clean();
      if (stopReason) reject(new CancelledError(stopReason));
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}
module.exports = { launch, CancelledError };

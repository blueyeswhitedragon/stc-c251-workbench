'use strict';
class IdentifyState {
  constructor() { this.reset(); }
  reset() { this.phase = 'idle'; this.message = '尚未识别'; this.deadline = null; this.released = null; }
  start() { this.reset(); this.phase = 'preparing'; this.message = '检查环境和串口，请先不要按 RES'; }
  event(event, now = Date.now()) {
    if (this.phase === 'cancelling') return;
    if (event.event === 'opening') { this.phase = 'opening'; this.message = event.message; }
    if (event.event === 'waiting') {
      this.phase = 'waiting'; this.message = event.message; this.released = false;
      this.deadline = now + Math.max(0, Number(event.seconds) || 0) * 1000;
    }
    if (event.event === 'reading') { this.phase = 'reading'; this.message = event.message; this.deadline = null; }
    if (event.event === 'closed') { this.released = event.released === true; this.deadline = null; this.phase = 'finishing'; this.message = '正在整理结果'; }
  }
  cancel() { this.phase = 'cancelling'; this.message = '正在取消并等待后端退出，请稍候'; this.deadline = null; }
  success() { this.phase = 'success'; this.message = '识别完成 · 串口已释放'; this.deadline = null; }
  fail(error) {
    this.phase = error.code === 'cancelled' ? 'cancelled' : error.code === 'timeout' ? 'timeout' : 'error';
    this.message = error.message; this.deadline = null;
  }
  view(now = Date.now()) {
    const labels = {idle:'尚未识别',preparing:'准备识别',opening:'打开串口',waiting:'等待 RES',reading:'读取信息',finishing:'整理结果',cancelling:'取消中',success:'识别成功',cancelled:'已取消',timeout:'等待超时',error:'识别失败'};
    const remaining = this.phase === 'waiting' ? Math.max(0, Math.ceil((this.deadline - now) / 1000)) : null;
    return {phase:this.phase, label:labels[this.phase], message:this.message, remaining, released:this.released,
      description:remaining === null ? this.message : `请现在按一下 RES · 剩余 ${remaining} 秒`};
  }
}
module.exports = { IdentifyState };

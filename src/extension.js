'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const core = require('./core');
const { launch, CancelledError } = require('./process');
const { IdentifyState } = require('./identify-state');
const { findKeil } = require('./toolchain');

let shutdown;
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function activate(context) {
  const output = vscode.window.createOutputChannel('STC C251 Workbench');
  const diagnostics = vscode.languages.createDiagnosticCollection('stc-c251');
  const changed = new vscode.EventEmitter();
  const state = { project: null, target: null, port: context.workspaceState.get('port', ''), device: null, hex: null, busy: '', stage: '', cancellation: null };
  const identification = new IdentifyState();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
  status.command = 'stcWorkbench.build';
  const config = () => vscode.workspace.getConfiguration('stcWorkbench');
  const log = message => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  const refresh = () => {
    status.text = state.busy ? `$(sync~spin) STC: ${state.stage || (state.busy === '只读识别' ? identification.view().label : state.busy)}` : `$(circuit-board) STC: ${state.target?.name || '导入工程'}`;
    status.command = state.busy ? 'stcWorkbench.cancel' : state.project ? 'stcWorkbench.build' : 'stcWorkbench.importProject';
    status.tooltip = 'STC C251 Workbench · STC32 独立烧录'; status.show(); changed.fire();
    void vscode.commands.executeCommand('setContext', 'stcWorkbench.busy', Boolean(state.busy));
  };
  const requireTrust = () => {
    if (process.platform !== 'win32') throw new Error('第一版仅支持 Windows 本机工作区。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再调用本地工具。');
  };
  const requireIdle = () => { if (state.busy) throw new Error(`当前正在${state.busy}，请等待或取消。`); };
  async function operation(label, action) {
    requireTrust(); requireIdle();
    state.busy = label; state.cancellation = new vscode.CancellationTokenSource(); refresh();
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `STC · ${label}`, cancellable: true }, async (progress, uiToken) => {
        const sub = uiToken.onCancellationRequested(() => state.cancellation?.cancel());
        try { return await action(state.cancellation.token, progress); } finally { sub.dispose(); }
      });
    } finally { state.cancellation.dispose(); state.cancellation = null; state.busy = ''; state.stage = ''; refresh(); }
  }
  async function loadProject(filename, targetName) {
    const stat = await fs.stat(filename);
    if (stat.size > 5 * 1024 * 1024) throw new Error('工程文件过大。');
    const project = core.parseProject(core.decode(await fs.readFile(filename)), filename);
    const target = project.targets.find(t => t.name === targetName) || project.targets[0];
    state.project = project; state.target = target; state.hex = null;
    await context.workspaceState.update('projectPath', project.filename);
    await context.workspaceState.update('target', target.name);
    refresh(); return project;
  }
  async function importProject(filename) {
    requireTrust(); requireIdle();
    if (typeof filename !== 'string') {
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, title: '选择 Keil C251 工程', filters: { 'Keil Project': ['uvproj', 'uvprojx'] } });
      if (!selected) return;
      filename = selected[0].fsPath;
    }
    const project = await loadProject(filename);
    if (project.targets.length > 1) await selectTarget();
    log(`已导入 ${project.filename}；Target: ${state.target.name}；工具链: ${state.target.toolset}`);
    return { path: project.filename, target: state.target.name };
  }
  async function selectTarget() {
    requireTrust(); requireIdle();
    if (!state.project) return importProject();
    const selected = await vscode.window.showQuickPick(state.project.targets.map(t => ({ label: t.name, description: `${t.device} · ${t.toolset}`, target: t })), { title: '选择 Keil Target' });
    if (selected) {
      state.target = selected.target; state.hex = null;
      await context.workspaceState.update('target', state.target.name); refresh();
    }
  }
  async function getKeil() {
    const specified = config().get('keilPath', '').trim();
    const executable = await findKeil(specified);
    if (executable) return executable;
    throw new Error('自动检测不到 UV4.exe。请运行「STC: 设置 Keil 路径」或检查 Keil/STC 工具链安装。');
  }
  async function detectKeil() {
    requireTrust(); requireIdle();
    const specified = config().get('keilPath', '').trim();
    const executable = await findKeil(specified);
    if (!executable) {
      log('Keil 自动检测失败：未找到 UV4.exe。未修改 PATH 或系统配置。');
      throw new Error('未找到 UV4.exe；可用「STC: 设置 Keil 路径」手动指定。');
    }
    log(`Keil 自动检测成功：${executable}`);
    void vscode.window.showInformationMessage(`已检测到 Keil：${executable}`);
    return { path: executable, configured: Boolean(specified) };
  }
  async function configureKeil() {
    requireTrust(); requireIdle();
    const selected = await vscode.window.showOpenDialog({ title: '选择 Keil UV4.exe（不是快捷方式）', filters: { Executable: ['exe'] }, canSelectMany: false });
    if (selected) await config().update('keilPath', selected[0].fsPath, vscode.ConfigurationTarget.Global);
  }
  async function blockOfficialIsp(token) {
    const result = await launch('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 10000, token });
    if (result.code !== 0) throw new Error('无法检查 STC-ISP 进程，已停止操作。');
    if (/"stc-isp[^"\r\n]*\.exe"/i.test(core.decode(result.stdout))) {
      throw new Error('请先关闭 STC-ISP。它可能占用串口或在 HEX 更新时自动触发下载。');
    }
  }
  async function renderDiagnostics(text, base) {
    diagnostics.clear();
    const groups = new Map();
    for (const item of core.parseDiagnostics(text, base)) {
      const uri = vscode.Uri.file(item.file);
      const d = new vscode.Diagnostic(new vscode.Range(item.line, item.column, item.line, item.column + 1), item.message, item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'Keil C251'; d.code = item.code;
      const entry = groups.get(uri.toString()) || { uri, items: [] }; entry.items.push(d); groups.set(uri.toString(), entry);
    }
    for (const group of groups.values()) diagnostics.set(group.uri, group.items);
  }
  async function checkHexFile(filename) {
    state.hex = null; refresh();
    if ((await fs.stat(filename)).size > 8 * 1024 * 1024) throw new Error('HEX 文件过大（上限 8 MiB）。');
    const info = core.inspectHex(await fs.readFile(filename));
    state.hex = { path: filename, ...info }; refresh();
    log(`HEX 校验通过：${filename}\n数据 ${info.bytes} 字节；地址 0x${info.min.toString(16).toUpperCase()}–0x${info.max.toString(16).toUpperCase()}；空洞 ${info.holes} 字节；离线块 ${info.blocks.length} 个\nSTC32 地址：代码 ${info.stc32AddressCheck.codeBytes} 字节，EEPROM 区 ${info.stc32AddressCheck.eepromBytes} 字节，范围外 ${info.stc32AddressCheck.outsideBytes} 字节${info.stc32AddressCheck.warning ? `\n警告：${info.stc32AddressCheck.warning}` : ''}\nSHA-256: ${info.sha256}\n注意：仅生成离线预览块，不代表允许烧录。`);
    return state.hex;
  }
  async function build(rebuild = false) {
    requireTrust(); requireIdle();
    if (!state.project) { await importProject(); if (!state.project) return; }
    if (!await vscode.workspace.saveAll(false)) throw new Error('保存文件未完成，编译已取消。');
    // Refresh from disk: the Keil project may have changed since import.
    await loadProject(state.project.filename, state.target.name);
    const project = state.project, target = state.target;
    if (target.hooks.length) {
      const answer = await vscode.window.showWarningMessage(`工程包含编译前后命令，执行 Build 会运行它们：\n${target.hooks.join('\n')}`, { modal: true }, '允许本次编译');
      if (answer !== '允许本次编译') return;
    }
    const executable = await getKeil();
    return operation(rebuild ? '重新编译' : '编译', async (token, progress) => {
      await blockOfficialIsp(token); output.show(true); diagnostics.clear();
      const folder = path.join(context.globalStorageUri.fsPath, 'build-logs');
      await fs.mkdir(folder, { recursive: true });
      const logfile = path.join(folder, `build-${Date.now()}.log`);
      const args = core.buildArgs(project.filename, target, logfile, rebuild);
      log(`${rebuild ? 'Rebuild' : 'Build'}: ${target.name}\n工程：${project.filename}\n编译器入口：${executable}`);
      let lastText = '';
      let polling = false;
      const poll = async () => {
        if (polling) return; polling = true;
        try {
          const text = core.decode(await fs.readFile(logfile), config().get('logEncoding', 'auto'));
          // Re-read the complete file so a split multi-byte character is never decoded in isolation.
          if (text.startsWith(lastText)) output.append(text.slice(lastText.length));
          else if (text !== lastText) output.append(text);
          lastText = text;
        } catch {} finally { polling = false; }
      };
      const timer = setInterval(poll, 500);
      let result;
      try {
        progress.report({ message: 'Keil 正在构建；可随时取消。' });
        result = await launch(executable, args, { cwd: path.dirname(project.filename), timeout: config().get('buildTimeout', 300) * 1000, token });
      } finally { clearInterval(timer); }
      // Wait for the current asynchronous poll to finish, then read final bytes.
      while (polling) await new Promise(resolve => setTimeout(resolve, 20));
      await poll();
      const combined = lastText + '\n' + core.decode(result.stdout) + '\n' + core.decode(result.stderr);
      await renderDiagnostics(combined, path.dirname(project.filename));
      const ok = core.buildSucceeded(result.code, combined);
      if (!ok) {
        state.hex = null; log(`编译未通过（退出码 ${result.code}），没有执行下载。完整日志：${logfile}`);
        throw new Error('编译失败或缺少成功摘要，请查看 STC 输出和“问题”面板。');
      }
      let hex = null;
      if (target.hexEnabled && target.hexPath && await exists(target.hexPath)) hex = await checkHexFile(target.hexPath);
      log(`编译成功${result.code === 1 ? '（有警告）' : ''}。没有执行烧录。`);
      void vscode.window.showInformationMessage(`STC ${rebuild ? 'Rebuild' : 'Build'} 成功${hex ? '，HEX 校验通过' : '，未找到 HEX 产物'}。`);
      return { success: true, exitCode: result.code, logPath: logfile, hex };
    });
  }
  const managedPython = () => path.join(context.globalStorageUri.fsPath, 'python-env', 'Scripts', 'python.exe');
  async function getPython() {
    const override = config().get('probePythonPath', '').trim();
    if (override) return override;
    if (await exists(managedPython())) return managedPython();
    throw new Error('尚未配置识别环境。请运行「STC: 配置芯片识别环境」（需本机 Python 3.10+）。');
  }
  async function runBackend(python, args, token, onEvent, timeout = 30000) {
    let pending = ''; const decoder = new StringDecoder('utf8'); const events = [];
    const consume = text => {
      pending += text;
      while (pending.includes('\n')) {
        const newline = pending.indexOf('\n'); const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { log(`后端非 JSON 输出：${line}`); continue; }
        events.push(event); onEvent?.(event);
      }
    };
    const result = await launch(python, ['-u', path.join(context.extensionPath, 'python', 'backend.py'), ...args], {
      cwd: context.extensionPath, timeout, token, env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      onStdout: data => consume(decoder.write(data))
    });
    consume(decoder.end());
    if (result.code !== 0) {
      const failure = events.findLast(e => e.event === 'error');
      throw Object.assign(new Error(failure?.message || core.decode(result.stderr) || `后端退出码 ${result.code}`), {code:failure?.code || 'backend_failed'});
    }
    return events;
  }
  async function setupPython() {
    requireTrust(); requireIdle();
    const answer = await vscode.window.showInformationMessage('将用本机 Python 创建插件独立环境，并离线安装随插件附带的 pyserial/tqdm/colorama。不会修改系统 Python 或 PATH。', { modal: true }, '创建独立环境');
    if (answer !== '创建独立环境') return;
    return operation('配置识别环境', async token => {
      output.show(true);
      await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
      const python = config().get('pythonPath', 'python');
      const check = await launch(python, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)'], { token });
      if (check.code !== 0) throw new Error('需要 Python 3.10 或更新版本。');
      const created = await launch(python, ['-m', 'venv', path.dirname(path.dirname(managedPython()))], { token, timeout: 120000 });
      if (created.code !== 0) throw new Error(core.decode(created.stderr) || '创建独立环境失败');
      const installed = await launch(managedPython(), ['-m', 'pip', 'install', '--no-index', '--disable-pip-version-check', '--find-links', path.join(context.extensionPath, 'python', 'wheels'), 'pyserial==3.5', 'tqdm==4.70.1', 'colorama==0.4.6'], { token, timeout: 120000 });
      log(core.decode(installed.stdout));
      if (installed.code !== 0) throw new Error(core.decode(installed.stderr));
      await runBackend(managedPython(), ['check'], token);
      void vscode.window.showInformationMessage('STC 独立识别环境已配置完成。');
    });
  }
  async function selectPort(requestedPort) {
    requireTrust(); requireIdle();
    const python = await getPython();
    return operation('选择串口', async token => {
    const events = await runBackend(python, ['ports'], token);
    const ports = events.find(e => e.event === 'ports')?.ports || [];
    if (!ports.length) throw new Error('没有找到串口，请检查 Type-C 连接和 CH340 驱动。');
    ports.sort((a,b) => Number(!/CH340|CH343/i.test(a.description)) - Number(!/CH340|CH343/i.test(b.description)));
    const selected = typeof requestedPort === 'string'
      ? ports.find(p => p.port.toLowerCase() === requestedPort.toLowerCase())
      : await vscode.window.showQuickPick(ports.map(p => ({ label: p.port, description: p.description, port: p.port })), { title: '选择开发板串口（不会自动选择蓝牙端口）' }, token);
    if (typeof requestedPort === 'string' && !selected) throw new Error('指定串口当前不存在，请重新连接并选择串口。');
    if (selected && !token.isCancellationRequested) { state.port = selected.port; state.device = null; identification.reset(); await context.workspaceState.update('port', state.port); refresh(); return {port:state.port}; }
    });
  }
  async function identify() {
    requireTrust(); requireIdle();
    if (!state.port) { await selectPort(); if (!state.port) return; }
    return operation('只读识别', async (token, progress) => {
      state.device = null; identification.start(); output.show(true); refresh();
      const updateProgress = () => { progress.report({message:identification.view().description}); refresh(); };
      const timer = setInterval(updateProgress, 1000);
      const cancelled = token.onCancellationRequested(() => { identification.cancel(); updateProgress(); });
      try {
      updateProgress();
      const python = await getPython();
      await blockOfficialIsp(token);
      const ports = (await runBackend(python, ['ports'], token)).find(e => e.event === 'ports')?.ports || [];
      if (!ports.some(p => p.port === state.port)) throw Object.assign(new Error('所选串口已断开或端口号变化，请重新连接并选择串口。'), {code:'port_missing'});
      log(`识别 ${state.port}：仅发送同步和识别报文，不擦除、不写入、不调频。取消后如板子停在下载模式，可再按 RES。`);
      const seconds = config().get('probeTimeout', 180);
      const events = await runBackend(python, ['identify', '--port', state.port, '--seconds', String(seconds)], token, event => {
        identification.event(event); updateProgress();
        if (event.message) log(event.message);
      }, (seconds + 15) * 1000);
      const snapshot = events.find(e => e.event === 'identified')?.snapshot;
      if (!snapshot) throw new Error('后端没有返回有效识别结果。');
      if (identification.released !== true) throw new Error('后端未确认串口释放，不将此次操作标记为成功。');
      if (token.isCancellationRequested) throw new CancelledError();
      try {
        const folder = path.join(context.globalStorageUri.fsPath, 'captures'); await fs.mkdir(folder, { recursive: true });
        const file = path.join(folder, `capture-${Date.now()}.json`);
        await fs.writeFile(file, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' });
        log(`原始状态：${file}`);
      } catch (error) { log(`芯片已识别，但本地记录保存失败：${error.message}`); }
      state.device = snapshot; identification.success(); refresh();
      log(`已识别 ${snapshot.model}，BSL ${snapshot.bsl_version}；串口已释放。`);
      void vscode.window.showInformationMessage(`识别成功：${snapshot.model} / ${snapshot.bsl_version}。配置映射仍待核验，未执行烧录。`);
      return snapshot;
      } catch (error) {
        if (error.code === 'cancelled') error.message = '识别已取消，后端已退出；未擦写。可重新点击识别，若板子停在下载模式可按 RES。';
        identification.fail(error); state.device = null; refresh(); throw error;
      } finally { clearInterval(timer); cancelled.dispose(); }
    });
  }
  async function checkHex(filename) {
    requireTrust(); requireIdle();
    if (typeof filename !== 'string') filename = state.target?.hexPath;
    if (!filename || !await exists(filename)) {
      const picked = await vscode.window.showOpenDialog({ title: '选择待检查的 HEX（不会烧录）', filters: { 'Intel HEX': ['hex', 'ihx'] }, canSelectMany: false });
      if (!picked) return; filename = picked[0].fsPath;
    }
    output.show(true); return checkHexFile(filename);
  }
  async function previewHexBlocks(filename) {
    requireTrust(); requireIdle();
    if (!state.hex || (filename && path.resolve(filename) !== path.resolve(state.hex.path))) await checkHex(filename);
    if (!state.hex) return;
    const items = state.hex.blocks.map((block, index) => ({
      label: `块 ${index + 1}: 0x${block.address.toString(16).toUpperCase()}`,
      description: `${block.bytes} 字节 · SHA-256 ${block.sha256.slice(0, 16)}…`,
      detail: '离线预览；不会发送到开发板',
    }));
    output.show(true);
    log(`HEX 离线分块预览：${state.hex.path}\n${state.hex.blocks.map((b, i) => `块 ${i + 1}: 地址 0x${b.address.toString(16).toUpperCase()}，${b.bytes} 字节，SHA-256 ${b.sha256}`).join('\n')}\n不会打开串口或执行烧录。`);
    await vscode.window.showQuickPick(items, { title: 'HEX 离线分块预览（不会烧录）', placeHolder: '选择分块查看校验摘要' });
    return { path: state.hex.path, blocks: state.hex.blocks, flashEnabled: false };
  }
  async function flashSafety() {
    requireTrust(); requireIdle();
    const report = core.flashSafetyChecklist({
      device: state.device, hex: state.hex, port: state.port,
      allowEepromErase: config().get('allowEepromErase', false),
      allowHardwareOptions: config().get('allowHardwareOptions', false),
    });
    const lines = report.checks.map(check => `${check.manual ? '⚠️' : (check.passed ? '✅' : '❌')} ${check.label}${check.manual ? '（待验证）' : ''}`);
    output.show(true);
    log(`烧录前安全检查（仅检查，不执行烧录）：\n${lines.join('\n')}\n当前仍禁止写入：${report.writeEnabled ? '否' : '是'}`);
    void vscode.window.showInformationMessage(`安全检查完成：${report.checks.filter(check => check.passed).length}/${report.checks.length} 项通过；真实烧录仍未开放。`);
    return report;
  }
  async function showDeviceStatus() {
    requireTrust(); requireIdle();
    if (!state.device) {
      void vscode.window.showInformationMessage('尚未完成只读识别。');
      return { available: false };
    }
    const device = state.device;
    const lines = [
      `型号：${device.model} (${device.model_magic})`,
      `BSL：${device.bsl_version}`,
      `状态字节：${device.raw_status_payload_bytes ?? '未知'}`,
      `硬件选项：${device.hardware_options_trust || '未验证'}`,
      'Flash/EEPROM 写入：未执行',
    ];
    output.show(true); log(`只读芯片状态详情：\n${lines.join('\n')}`);
    void vscode.window.showInformationMessage(`${device.model} / BSL ${device.bsl_version}；硬件选项未验证，未执行烧录。`);
    return { available: true, ...device, flash_write_performed: false };
  }
  async function simulateFlash() {
    requireTrust(); requireIdle();
    if (!state.hex) await checkHex();
    if (!state.hex) return { hardwareAccessed: false, writeEnabled: false, steps: [] };
    const result = core.simulateFlash(state.hex);
    output.show(true); log(`离线烧录流程模拟：\n${result.steps.map((step, index) => `${index + 1}. ${step.name}：${step.result}`).join('\n')}\n硬件访问：否；真实写入：禁用。`);
    void vscode.window.showInformationMessage(`离线流程模拟完成：${result.steps.length} 步；没有访问开发板。`);
    return result;
  }
  async function flash() {
    requireTrust(); requireIdle();
    if (!state.port) { await selectPort(); if (!state.port) return { flashed: false }; }
    if (!state.hex) await checkHex();
    if (!state.hex) return { flashed: false };
    if (state.hex.stc32AddressCheck?.eepromBytes) throw new Error('当前按钮不接受 HEX 中的 EEPROM 数据；请将 EEPROM 数据单独保存。');
    if (!state.hex.stc32AddressCheck?.safe) throw new Error('HEX 含 STC32 不支持地址，已停止烧录。');
    const answer = await vscode.window.showWarningMessage(
      `即将通过 ${state.port} 擦除并写入 STC32G12K128 代码区（${state.hex.bytes} 字节）。EEPROM 和硬件选项不会修改。请确认后按 RES。`,
      { modal: true }, '开始烧录');
    if (answer !== '开始烧录') return { flashed: false, cancelled: true };
    return operation('独立烧录', async (token, progress) => {
      let reported = 0;
      const stage = (message, percent) => {
        state.stage = message; refresh();
        const update = { message };
        if (Number.isFinite(percent)) { const next = Math.max(reported, Math.min(100, percent)); update.increment = next - reported; reported = next; }
        progress.report(update);
      };
      output.show(true); await blockOfficialIsp(token);
      const python = await getPython();
      const ports = (await runBackend(python, ['ports'], token)).find(e => e.event === 'ports')?.ports || [];
      if (!ports.some(p => p.port.toLowerCase() === state.port.toLowerCase())) throw new Error('所选串口已断开，请重新连接开发板。');
      const seconds = config().get('probeTimeout', 180);
      log(`独立烧录 ${state.port}：${state.hex.path}\nSHA-256：${state.hex.sha256}\n仅代码区；EEPROM/硬件选项保持不变。`);
      const events = await runBackend(python, ['flash', '--port', state.port, '--hex', state.hex.path, '--seconds', String(seconds)], token, event => {
        if (event.message) log(event.message);
        if (event.event === 'waiting') stage('请按一下开发板 RES，等待芯片响应…');
        if (event.event === 'identified') stage('已识别 STC32G12K128，正在擦除代码区…');
        if (event.event === 'writing') stage(`正在下载 ${event.total} 字节…`, 0);
        if (event.event === 'progress' && event.total) stage(`正在下载 ${event.done}/${event.total} 字节…`, event.done / event.total * 100);
        if (event.event === 'verified') stage(`已确认 ${event.blocks} 个写入块和结束包（协议校验）…`, 100);
      }, (seconds + 30) * 1000);
      if (token.isCancellationRequested) throw new CancelledError();
      const result = events.find(e => e.event === 'flashed');
      if (!result) throw new Error('后端没有返回烧录成功确认。');
      state.device = null; identification.reset(); refresh();
      log(`烧录成功：${result.bytes} 字节，${result.blocks} 个 64 字节块；HEX SHA-256 ${result.sha256}；镜像 SHA-256 ${result.imageSha256}；已确认块 ACK/结束 ACK（未执行芯片读回）；串口已释放。`);
      void vscode.window.showInformationMessage('STC32G12K128 烧录成功，开发板已复位运行。');
      return result;
    });
  }
  async function monitorSerial() {
    requireTrust(); requireIdle();
    if (!state.port) { await selectPort(); if (!state.port) return { monitored: false }; }
    return operation('串口监视器', async (token, progress) => {
      output.show(true);
      const python = await getPython();
      const baud = config().get('monitorBaud', 115200);
      log(`串口监视器：${state.port} @ ${baud}；点击“取消当前操作”停止。`);
      const seconds = 24 * 60 * 60;
      const events = await runBackend(python, ['monitor', '--port', state.port, '--baud', String(baud), '--seconds', String(seconds)], token, event => {
        if (event.event === 'opened') progress.report({ message: `正在监听 ${state.port} @ ${baud}…` });
        if (event.event === 'data') output.append(event.text || '');
        if (event.event === 'closed') log('串口监视器已关闭，串口已释放。');
      }, seconds * 1000 + 5000);
      return { monitored: true, events: events.filter(event => event.event === 'data').length };
    });
  }
  async function openOfficialIsp() {
    requireTrust(); requireIdle();
    const executable = config().get('officialIspPath', '').trim();
    if (!executable || !await exists(executable)) throw new Error('请先在设置中配置官方 STC-ISP 可执行文件路径。');
    if (!state.hex) await checkHex();
    if (!state.hex) return { opened: false };
    log(`准备打开官方 STC-ISP。HEX：${state.hex.path}\nSHA-256：${state.hex.sha256}\n插件不会自动传参、不会自动点击下载；请在官方窗口核对 COM、EEPROM 和硬件选项。`);
    const result = await launch(executable, [], { cwd: path.dirname(executable), timeout: 15000 });
    if (result.code !== 0) throw new Error(`官方 STC-ISP 启动失败（退出码 ${result.code}）。`);
    return { opened: true, executable, hex: state.hex.path, flashEnabled: false };
  }
  const item = (label, command, description, icon = 'chevron-right') => ({ label, command, description, icon });
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem(element) {
      const tree = new vscode.TreeItem(element.label, element.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      tree.description = element.description; tree.tooltip = element.tooltip || element.description || element.label;
      tree.iconPath = new vscode.ThemeIcon(element.icon || 'chevron-right');
      if (element.command) tree.command = { command: element.command, title: element.label, arguments: element.args || [] };
      return tree;
    },
    getChildren(element) {
      if (element) return element.children || [];
      return [
        item('导入 Keil 工程', 'stcWorkbench.importProject', state.project ? path.basename(state.project.filename) : '选择 .uvproj', 'folder-opened'),
        item('Target', 'stcWorkbench.selectTarget', state.target?.name || '未选择', 'list-selection'),
        item('Build', 'stcWorkbench.build', state.target?.toolset || 'C251', 'tools'),
        item('Rebuild', 'stcWorkbench.rebuild', '全部重新编译', 'refresh'),
        item('自动检测 Keil', 'stcWorkbench.detectKeil', '只读检查 UV4.exe 安装位置', 'search'),
        item('识别环境', 'stcWorkbench.setupPython', '首次使用时配置', 'python'),
        item('串口', 'stcWorkbench.selectPort', state.port || '未选择', 'plug'),
        item('串口监视器', 'stcWorkbench.monitorSerial', state.port ? `监听 ${state.port}` : '先选择串口', 'terminal'),
        item('识别芯片', 'stcWorkbench.identify', '只读 · 按 RES', 'circuit-board'),
        item(identification.view().label, 'stcWorkbench.showOutput', identification.view().description, identification.phase === 'success' ? 'check' : 'info'),
        ...(['error','timeout','cancelled'].includes(identification.phase) && !state.busy ? [item('重新识别', 'stcWorkbench.identify', '连接正常后点击，再按提示 RES', 'refresh')] : []),
        ...(state.device ? [item(state.device.model, 'stcWorkbench.showDeviceStatus', `BSL ${state.device.bsl_version} · 只读详情`, 'check')] : []),
        item('校验 HEX', 'stcWorkbench.checkHex', state.hex ? `${state.hex.bytes} 字节 · ${state.hex.blocks.length} 个离线块` : '格式与地址检查', 'file-binary'),
        ...(state.hex ? [item('预览 HEX 分块', 'stcWorkbench.previewHexBlocks', '地址与 SHA-256 · 不烧录', 'list-flat')] : []),
        ...(state.hex ? [item('模拟烧录流程', 'stcWorkbench.simulateFlash', '离线 · 不访问硬件', 'beaker')] : []),
        item('烧录前安全检查', 'stcWorkbench.flashSafety', '仅检查 · 当前不可写入', 'shield'),
        item('烧录到开发板', 'stcWorkbench.flash', state.hex ? '独立串口烧录 · 按 RES' : '先校验 HEX', 'rocket'),
        item('打开官方 STC-ISP', 'stcWorkbench.openOfficialIsp', '受控下载通道 · 手动确认', 'external-link'),
        ...(state.busy ? [item('取消当前操作', 'stcWorkbench.cancel', state.busy, 'debug-stop')] : []),
        item('查看日志', 'stcWorkbench.showOutput', '', 'output'),
        { label: '工程源文件', icon: 'files', children: (state.target?.files || []).map(file => ({ label: path.basename(file), description: path.relative(path.dirname(state.project.filename), file), icon: 'file-code', tooltip: file, command: 'vscode.open', args: [vscode.Uri.file(file)] })) }
      ];
    }
  };
  const commands = {
    importProject, selectTarget, configureKeil, detectKeil, build: () => build(false), rebuild: () => build(true),
    setupPython, selectPort, identify, checkHex, previewHexBlocks, simulateFlash, flashSafety, showDeviceStatus, openOfficialIsp, flash, monitorSerial,
    cancel: () => state.cancellation?.cancel(),
    showOutput: () => output.show(true),
    settings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:stc-workbench-local.stc-c251-workbench')
  };
  for (const [name, handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`stcWorkbench.${name}`, async (...args) => {
    try { requireTrust(); return await handler(...args); }
    catch (error) {
      log(error.message);
      if (error instanceof CancelledError) void vscode.window.showInformationMessage(error.message);
      else void vscode.window.showErrorMessage(`STC: ${error.message}`);
      return { success: false, error: error.message };
    }
  }));
  context.subscriptions.push(output, diagnostics, changed, status, vscode.window.registerTreeDataProvider('stcWorkbench.home', provider));
  shutdown = () => state.cancellation?.cancel();
  const restore = async () => {
    const saved = context.workspaceState.get('projectPath');
    if (saved && vscode.workspace.isTrusted) {
      try { await loadProject(saved, context.workspaceState.get('target')); } catch (error) { log(`上次工程未恢复：${error.message}`); }
    }
    refresh();
  };
  const ready = restore();
  return { ready, getState: () => ({ project: state.project?.filename, target: state.target?.name, port: state.port, busy: state.busy, stage: state.stage, hex: state.hex, identification:identification.view(), device:state.device ? {model:state.device.model,bsl_version:state.device.bsl_version} : null, flashEnabled: true }) };
}
function deactivate() { shutdown?.(); }
module.exports = { activate, deactivate };

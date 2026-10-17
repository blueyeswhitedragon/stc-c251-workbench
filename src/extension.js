'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const core = require('./core');
const { launch, CancelledError } = require('./process');

let shutdown;
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function activate(context) {
  const output = vscode.window.createOutputChannel('STC C251 Workbench');
  const diagnostics = vscode.languages.createDiagnosticCollection('stc-c251');
  const changed = new vscode.EventEmitter();
  const state = { project: null, target: null, port: context.workspaceState.get('port', ''), device: null, hex: null, busy: '', cancellation: null };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
  status.command = 'stcWorkbench.build';
  const config = () => vscode.workspace.getConfiguration('stcWorkbench');
  const log = message => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  const refresh = () => {
    status.text = state.busy ? `$(sync~spin) STC: ${state.busy}` : `$(circuit-board) STC: ${state.target?.name || '导入工程'}`;
    status.command = state.busy ? 'stcWorkbench.cancel' : state.project ? 'stcWorkbench.build' : 'stcWorkbench.importProject';
    status.tooltip = 'STC C251 Workbench · 实际擦写禁用'; status.show(); changed.fire();
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
    } finally { state.cancellation.dispose(); state.cancellation = null; state.busy = ''; refresh(); }
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
    const candidates = specified ? [specified] : ['C:\\Keil_v5\\UV4\\UV4.exe', 'C:\\Keil\\UV4\\UV4.exe', 'C:\\Keil_v5\\UV4.exe'];
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    throw new Error('找不到 UV4.exe。请运行「STC: 设置 Keil 路径」。');
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
    log(`HEX 校验通过：${filename}\n数据 ${info.bytes} 字节；地址 0x${info.min.toString(16).toUpperCase()}–0x${info.max.toString(16).toUpperCase()}；空洞 ${info.holes} 字节\nSHA-256: ${info.sha256}\n注意：格式校验通过不代表允许烧录。`);
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
    if (result.code !== 0) throw new Error(events.findLast(e => e.event === 'error')?.message || core.decode(result.stderr) || `后端退出码 ${result.code}`);
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
  async function selectPort() {
    requireTrust(); requireIdle();
    const python = await getPython();
    const events = await operation('扫描串口', token => runBackend(python, ['ports'], token));
    const ports = events.find(e => e.event === 'ports')?.ports || [];
    if (!ports.length) throw new Error('没有找到串口，请检查 Type-C 连接和 CH340 驱动。');
    ports.sort((a,b) => Number(!/CH340|CH343/i.test(a.description)) - Number(!/CH340|CH343/i.test(b.description)));
    const selected = await vscode.window.showQuickPick(ports.map(p => ({ label: p.port, description: p.description, port: p.port })), { title: '选择开发板串口（不会自动选择蓝牙端口）' });
    if (selected) { state.port = selected.port; state.device = null; await context.workspaceState.update('port', state.port); refresh(); }
  }
  async function identify() {
    requireTrust(); requireIdle();
    if (!state.port) { await selectPort(); if (!state.port) return; }
    const python = await getPython();
    return operation('只读识别', async (token, progress) => {
      await blockOfficialIsp(token); state.device = null; output.show(true); refresh();
      log(`识别 ${state.port}：仅发送同步和识别报文，不擦除、不写入、不调频。取消后如板子停在下载模式，可再按 RES。`);
      const seconds = config().get('probeTimeout', 180);
      const events = await runBackend(python, ['identify', '--port', state.port, '--seconds', String(seconds)], token, event => {
        if (event.event === 'waiting') {
          log(event.message); progress.report({ message: `请现在按一下 RES；最多等待 ${seconds} 秒。` });
          void vscode.window.showInformationMessage(`STC ${state.port} 已打开，请按一下 RES。`);
        } else if (event.event === 'log' || event.event === 'error') log(event.message);
      }, (seconds + 15) * 1000);
      const snapshot = events.find(e => e.event === 'identified')?.snapshot;
      if (!snapshot) throw new Error('后端没有返回有效识别结果。');
      const folder = path.join(context.globalStorageUri.fsPath, 'captures'); await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, `capture-${Date.now()}.json`);
      await fs.writeFile(file, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' });
      state.device = snapshot; refresh();
      log(`已识别 ${snapshot.model}，BSL ${snapshot.bsl_version}；串口已释放。原始状态：${file}`);
      void vscode.window.showInformationMessage(`识别成功：${snapshot.model} / ${snapshot.bsl_version}。配置映射仍待核验，未执行烧录。`);
      return snapshot;
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
  async function flash() {
    // Intentionally no subprocess, backend dispatch, bypass setting, or firmware write.
    log(core.FLASH_BLOCK_REASON);
    void vscode.window.showWarningMessage(core.FLASH_BLOCK_REASON);
    return { enabled: false, reason: core.FLASH_BLOCK_REASON };
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
        item('识别环境', 'stcWorkbench.setupPython', '首次使用时配置', 'python'),
        item('串口', 'stcWorkbench.selectPort', state.port || '未选择', 'plug'),
        item('识别芯片', 'stcWorkbench.identify', '只读 · 按 RES', 'circuit-board'),
        ...(state.device ? [item(state.device.model, 'stcWorkbench.showOutput', `BSL ${state.device.bsl_version}`, 'check')] : []),
        item('校验 HEX', 'stcWorkbench.checkHex', state.hex ? `${state.hex.bytes} 字节` : '格式与地址检查', 'file-binary'),
        item('烧录：暂不可用', 'stcWorkbench.flash', '配置映射待核验', 'lock'),
        ...(state.busy ? [item('取消当前操作', 'stcWorkbench.cancel', state.busy, 'debug-stop')] : []),
        item('查看日志', 'stcWorkbench.showOutput', '', 'output'),
        { label: '工程源文件', icon: 'files', children: (state.target?.files || []).map(file => ({ label: path.basename(file), description: path.relative(path.dirname(state.project.filename), file), icon: 'file-code', tooltip: file, command: 'vscode.open', args: [vscode.Uri.file(file)] })) }
      ];
    }
  };
  const commands = {
    importProject, selectTarget, configureKeil, build: () => build(false), rebuild: () => build(true),
    setupPython, selectPort, identify, checkHex, flash,
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
  return { ready, getState: () => ({ project: state.project?.filename, target: state.target?.name, port: state.port, busy: state.busy, hex: state.hex, flashEnabled: false }) };
}
function deactivate() { shutdown?.(); }
module.exports = { activate, deactivate };

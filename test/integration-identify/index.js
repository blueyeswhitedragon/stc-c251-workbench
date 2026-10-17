'use strict';
// Opt-in hardware acceptance test. Not run by npm test. No build/flash commands.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async function () {
  assert.equal(process.env.STC_HARDWARE_TEST, '1', 'Explicit hardware-test opt-in required');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(path.basename(root), 'stc-identify-test', 'Use a dedicated test workspace');
  const port = process.env.STC_HARDWARE_PORT;
  const python = process.env.STC_HARDWARE_PYTHON;
  assert.ok(port && python, 'Explicit serial port and isolated Python required');
  const scenario = process.env.STC_HARDWARE_SCENARIO || 'cancel-retry';
  assert.ok(['cancel-retry','timeout-retry','unplug-retry'].includes(scenario), 'Unknown hardware test scenario');
  const runId = Date.now();
  const reportPath = path.join(root, `identify-${scenario}-${runId}.json`);
  const report = {startedAt:new Date().toISOString(),port,scenario,steps:[],flashEnabled:false};
  const ext = vscode.extensions.getExtension('stc-workbench-local.stc-c251-workbench');
  const api = await ext.activate(); await api.ready;
  const cfg = vscode.workspace.getConfiguration('stcWorkbench');
  await cfg.update('probePythonPath',python,vscode.ConfigurationTarget.Global);
  await cfg.update('probeTimeout',scenario === 'timeout-retry' ? 10 : 300,vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.view.extension.stcWorkbench');
  const selected = await vscode.commands.executeCommand('stcWorkbench.selectPort',port);
  assert.equal(selected.port,port);report.steps.push('enumerate-and-select');
  const save = async () => fs.writeFile(reportPath, JSON.stringify({...report,state:api.getState()},null,2));
  let lastPhase, writes = Promise.resolve();
  const timer = setInterval(()=>{
    const phase=api.getState().identification.phase;
    if(phase!==lastPhase){lastPhase=phase;report.steps.push(phase);writes=writes.then(save);}
  },200);
  try {
    report.attempt = scenario === 'timeout-retry' ? 'do-not-press-res-timeout-test' : scenario === 'unplug-retry' ? 'unplug-while-waiting' : 'cancel-test';
    await save();
    // Confirm timeout/cancellation releases the backend before reopening the port.
    const initial = vscode.commands.executeCommand('stcWorkbench.identify');
    if (scenario === 'unplug-retry') {
      const first = await initial;
      assert.equal(first.success, false, 'Unplug attempt must fail rather than identify');
      assert.equal(api.getState().identification.phase, 'error', first.error);
      assert.equal(api.getState().identification.released, true);
      assert.equal(api.getState().busy, '');
      assert.equal(api.getState().device, null);
      report.steps.push('real-unplug-backend-exited');
      report.disconnectMessage = first.error;
      // The cable must remain disconnected until the operator confirms this check.
      const missing = await vscode.commands.executeCommand('stcWorkbench.identify');
      assert.equal(missing.success, false);
      assert.match(missing.error, /所选串口已断开或端口号变化/);
      assert.equal(api.getState().busy, '');
      report.steps.push('real-missing-port-preflight');
      report.attempt = 'await-reconnect-confirmation';
      report.reconnectRequest = path.join(root, `reconnect-${runId}.json`);
      await save();
      // Deliberately do not guess which newly appearing USB device is the user's board.
      // A local operator supplies the freshly enumerated port after reconnecting.
      let request;
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        try { request = JSON.parse(await fs.readFile(report.reconnectRequest, 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(request && typeof request.port === 'string', 'Reconnect confirmation timed out; no port was opened');
      const reselected = await vscode.commands.executeCommand('stcWorkbench.selectPort', request.port);
      assert.equal(reselected.port, request.port, reselected.error);
      report.reconnectedPort = request.port;
      report.steps.push('real-reconnect-port-reselected');
    } else if (scenario === 'timeout-retry') {
      const first = await initial;
      assert.equal(first.success, false, 'The no-RES attempt must time out; unexpected success does not validate timeout');
      assert.equal(api.getState().identification.phase, 'timeout', first.error);
      assert.equal(api.getState().identification.released, true);
      assert.equal(api.getState().busy, '');
      assert.equal(api.getState().device, null);
      report.steps.push('real-timeout-port-released');
    } else {
    for(let i=0;i<100 && !['waiting','success','error','timeout'].includes(api.getState().identification.phase);i++)await new Promise(r=>setTimeout(r,100));
    if(api.getState().identification.phase==='waiting') {
      await vscode.commands.executeCommand('stcWorkbench.cancel');await initial;
      assert.equal(api.getState().busy,'');assert.equal(api.getState().identification.phase,'cancelled');
      report.steps.push('real-cancel-backend-exited');
    } else {
      const first=await initial;assert.ok(first.model,first.error);report.steps.push('initial-identification-completed-before-cancel');
    }
    }
    await cfg.update('probeTimeout',300,vscode.ConfigurationTarget.Global);
    report.attempt='user-res';await save();
    const result=await vscode.commands.executeCommand('stcWorkbench.identify');
    assert.equal(result.model,'STC32G12K128',result.error);
    assert.equal(result.flash_write_performed,false);
    assert.equal(api.getState().identification.phase,'success');
    assert.equal(api.getState().identification.released,true);
    assert.equal(api.getState().busy,'');
    report.steps.push('real-identification-pass');
    report.result={model:result.model,bsl_version:result.bsl_version};
    report.success=true;report.completedAt=new Date().toISOString();
    console.log('STC_IDENTIFY_HARDWARE_PASS');
  } catch(error) {
    report.success=false;report.error=error.message;throw error;
  } finally {clearInterval(timer);await writes;await save();}
};

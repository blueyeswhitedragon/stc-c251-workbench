'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async function () {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(path.basename(root), 'keil-copy-error');
  const ext = vscode.extensions.getExtension('stc-workbench-local.stc-c251-workbench');
  const api = await ext.activate(); await api.ready;
  await vscode.commands.executeCommand('stcWorkbench.importProject', path.join(root,'Project/MDK/SEEKFREE.uvproj'));
  const result = await vscode.commands.executeCommand('stcWorkbench.rebuild');
  assert.equal(result.success, false); assert.equal(api.getState().hex, null);
  const errors = vscode.languages.getDiagnostics().flatMap(([uri,items]) => items.filter(d => d.source === 'Keil C251' && d.severity === vscode.DiagnosticSeverity.Error).map(d => ({file:uri.fsPath,line:d.range.start.line,code:d.code,message:d.message})));
  assert.ok(errors.length > 0, 'Compiler failure must be navigable in Problems');
  assert.ok(errors.some(e => e.file.endsWith('stc_mvp_error.c') && e.line === 0));
  await fs.writeFile(path.join(root,'integration-error-result.json'), JSON.stringify({success:true,buildRejected:true,hexCleared:true,diagnostics:errors},null,2));
  console.log('STC_ERROR_INTEGRATION_PASS');
};

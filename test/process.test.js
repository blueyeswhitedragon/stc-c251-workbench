'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch, CancelledError } = require('../src/process');
test('arguments are passed literally with no shell interpretation', async () => {
  const arg = '中文 空格 & echo injected | %PATH%';
  const r = await launch(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg]);
  assert.equal(r.code,0); assert.equal(r.stdout.toString(),arg);
});
test('stderr and nonzero exit retained', async () => {
  const r = await launch(process.execPath, ['-e', 'process.stderr.write("err");process.exit(3)']);
  assert.equal(r.code,3); assert.equal(r.stderr.toString(),'err');
});
test('missing executable rejects', async () => {
  await assert.rejects(launch('stc-workbench-nonexistent-test.exe', []), /ENOENT/);
});
test('timeout stops the owned process', async () => {
  await assert.rejects(launch(process.execPath, ['-e','setInterval(()=>{},1000)'], {timeout:300}), error => error instanceof CancelledError && error.code === 'timeout');
});
test('pre-cancel never launches', async () => {
  await assert.rejects(launch('must-not-launch.exe', [], {token:{isCancellationRequested:true}}), CancelledError);
});
test('cancellation stops a running process and disposes listener', async () => {
  let callback, disposed = false;
  const token = {isCancellationRequested:false, onCancellationRequested(fn) { callback = fn; return {dispose(){disposed=true;}}; }};
  const pending = launch(process.execPath, ['-e','console.log("ready");setInterval(()=>{},1000)'], {token, onStdout:()=>callback()});
  await assert.rejects(pending, error => error instanceof CancelledError && error.code === 'cancelled'); assert.equal(disposed,true);
});

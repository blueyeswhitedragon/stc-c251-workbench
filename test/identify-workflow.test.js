'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {CancelledError} = require('../src/process');
const extensionFile = path.resolve(__dirname, '../src/extension.js');
const originalRequire = createRequire(extensionFile);
function harness() {
  const commands = new Map(), notifications = [], phases = [], calls = [], settings = {probePythonPath:'fake-python',probeTimeout:10};
  const fixture = {outcome:'success',ports:[{port:'COM_TEST',description:'CH340'}],saveFails:false};
  let api;
  class CancellationTokenSource {
    constructor() {
      const listeners = new Set();
      this.token = {isCancellationRequested:false,onCancellationRequested(fn){listeners.add(fn);return {dispose:()=>listeners.delete(fn)};}};
      this.cancel = () => {this.token.isCancellationRequested=true;for(const fn of listeners)fn();};
    }
    dispose() {}
  }
  const dispose = () => {};
  const output = {appendLine(){},append(){},show(){},dispose};
  const vscode = {
    EventEmitter:class {fire(){} dispose(){} event(){}}, CancellationTokenSource,
    StatusBarAlignment:{Left:1}, ProgressLocation:{Notification:1},
    workspace:{isTrusted:true,getConfiguration:()=>({get:(k,d)=>settings[k]??d}),},
    commands:{registerCommand(name,handler){commands.set(name,handler);return {dispose};},async executeCommand(name,...args){return commands.get(name)?.(...args);}},
    languages:{createDiagnosticCollection:()=>({clear(){},set(){},dispose})},
    window:{
      createOutputChannel:()=>output,createStatusBarItem:()=>({show(){},dispose}),registerTreeDataProvider:()=>({dispose}),
      async withProgress(options,callback){return callback({report(){if(api)phases.push(api.getState().identification.phase);}},new CancellationTokenSource().token);},
      showInformationMessage:async message=>notifications.push(message),showErrorMessage:async message=>notifications.push(message),showWarningMessage:async message=>notifications.push(message)
    }
  };
  async function launch(executable,args,options) {
    calls.push({executable,args});
    if(options.token?.isCancellationRequested)throw new CancelledError();
    if(executable==='tasklist.exe')return {code:0,stdout:Buffer.from(fixture.outcome==='official'?'"stc-isp-v6.91C.exe"':''),stderr:Buffer.alloc(0)};
    const send = event => {
      const buffer = Buffer.from(JSON.stringify(event)+'\n');
      // Exercise the production incremental UTF-8 / JSON decoder.
      for (let i=0;i<buffer.length;i+=7)options.onStdout(buffer.subarray(i,i+7));
    };
    if(args.includes('ports'))send({event:'ports',ports:fixture.ports});
    if(args.includes('identify')) {
      send({event:'opening',message:'正在打开'});send({event:'waiting',seconds:10,message:'请按 RES'});
      if(fixture.outcome==='hold') {
        return new Promise((resolve,reject)=>options.token.onCancellationRequested(()=>reject(new CancelledError())));
      }
      if(['timeout','serial_unavailable'].includes(fixture.outcome)) {
        send({event:'closed',released:true});send({event:'error',code:fixture.outcome,message:'模拟错误'});
        return {code:2,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
      }
      send({event:'reading',message:'读取中'});
      if(fixture.outcome!=='unreleased')send({event:'closed',released:true});
      send({event:'identified',snapshot:{model:'STC32G12K128',bsl_version:'7.4.5U',flash_write_performed:false}});
    }
    return {code:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
  }
  const sandbox = {module:{exports:{}},require(name){
    if(name==='vscode')return vscode;
    if(name==='./process')return {launch,CancelledError};
    if(name==='node:fs/promises')return {async mkdir(){},async writeFile(){if(fixture.saveFails)throw new Error('simulated disk full');}};
    return originalRequire(name);
  },process,Buffer,console,setInterval,clearInterval,setTimeout};
  vm.runInNewContext(fs.readFileSync(extensionFile,'utf8'),sandbox,{filename:extensionFile});
  const saved = new Map([['port','COM_TEST']]);
  api = sandbox.module.exports.activate({subscriptions:[],extensionPath:path.dirname(extensionFile),globalStorageUri:{fsPath:'SIMULATED'},workspaceState:{get:(k,d)=>saved.get(k)??d,async update(k,v){saved.set(k,v);}}});
  return {api,fixture,phases,calls,notifications,run:(name,...args)=>commands.get('stcWorkbench.'+name)(...args)};
}
test('identify workflow reaches success after closed event and clears operation lock',async()=>{
  const h=harness();await h.api.ready;const r=await h.run('identify');
  assert.equal(r.model,'STC32G12K128');assert.equal(h.api.getState().busy,'');
  assert.equal(h.api.getState().identification.phase,'success');
  for(const p of ['preparing','opening','waiting','reading','finishing'])assert.ok(h.phases.includes(p),p);
  assert.equal(h.api.getState().flashEnabled,true);
});
test('timeout clears prior successful device and same command can retry',async()=>{
  const h=harness();await h.api.ready;await h.run('identify');h.fixture.outcome='timeout';
  const r=await h.run('identify');assert.equal(r.success,false);assert.equal(h.api.getState().device,null);
  assert.equal(h.api.getState().identification.phase,'timeout');assert.equal(h.api.getState().busy,'');
  h.fixture.outcome='success';assert.equal((await h.run('identify')).model,'STC32G12K128');
});
test('cancellation rejects concurrent work, clears lock and permits retry',async()=>{
  const h=harness();await h.api.ready;h.fixture.outcome='hold';const pending=h.run('identify');
  for(let i=0;i<50 && h.api.getState().identification.phase!=='waiting';i++)await new Promise(r=>setImmediate(r));
  assert.equal(h.api.getState().identification.phase,'waiting');
  assert.equal((await h.run('identify')).success,false);
  await h.run('cancel');await pending;
  assert.equal(h.api.getState().identification.phase,'cancelled');assert.equal(h.api.getState().busy,'');
  h.fixture.outcome='success';assert.equal((await h.run('identify')).model,'STC32G12K128');
});
test('removed port fails preflight without opening serial and can be reselected',async()=>{
  const h=harness();await h.api.ready;h.fixture.ports=[];
  assert.equal((await h.run('identify')).success,false);
  assert.ok(!h.calls.some(c=>c.args.includes('identify')));
  h.fixture.ports=[{port:'COM_NEW',description:'CH340'}];
  await h.run('selectPort','COM_NEW');assert.equal(h.api.getState().port,'COM_NEW');
  assert.equal((await h.run('identify')).model,'STC32G12K128');
});
test('serial failure and official ISP block leave a recoverable error state',async()=>{
  for(const outcome of ['serial_unavailable','official']) {
    const h=harness();await h.api.ready;h.fixture.outcome=outcome;
    assert.equal((await h.run('identify')).success,false);assert.equal(h.api.getState().busy,'');
    assert.equal(h.api.getState().identification.phase,'error');
    if(outcome==='official')assert.ok(!h.calls.some(c=>c.args.includes('identify')));
  }
});
test('missing close acknowledgement cannot show success',async()=>{
  const h=harness();await h.api.ready;h.fixture.outcome='unreleased';
  assert.equal((await h.run('identify')).success,false);assert.equal(h.api.getState().device,null);
});
test('capture storage failure does not misrepresent successful chip identification',async()=>{
  const h=harness();await h.api.ready;h.fixture.saveFails=true;
  assert.equal((await h.run('identify')).model,'STC32G12K128');assert.equal(h.api.getState().identification.phase,'success');
});

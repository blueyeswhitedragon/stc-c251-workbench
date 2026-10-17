'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IdentifyState} = require('../src/identify-state');
test('waiting countdown exists only while waiting for RES', () => {
  const state = new IdentifyState(); state.start();
  assert.equal(state.view().remaining, null);
  state.event({event:'waiting',seconds:10,message:'press'}, 1000);
  assert.equal(state.view(4000).remaining,7);
  assert.equal(state.view(20000).remaining,0);
  state.event({event:'reading',message:'read'});
  assert.equal(state.view().remaining,null);
  state.event({event:'closed',released:true}); state.success();
  assert.equal(state.view().phase,'success'); assert.equal(state.view().released,true);
});
test('cancelling cannot be overwritten by late backend waiting events', () => {
  const state = new IdentifyState(); state.start(); state.cancel();
  state.event({event:'waiting',seconds:10,message:'late'});
  assert.equal(state.view().phase,'cancelling'); assert.equal(state.view().remaining,null);
  state.fail({code:'cancelled',message:'cancelled'});
  assert.equal(state.view().phase,'cancelled');
});
test('timeout, missing port and cancellation are distinct and retries reset state', () => {
  const state = new IdentifyState();
  for (const [code,phase] of [['timeout','timeout'],['serial_unavailable','error'],['cancelled','cancelled']]) {
    state.start(); state.fail({code,message:code}); assert.equal(state.view().phase,phase);
    state.start(); assert.equal(state.view().phase,'preparing'); assert.equal(state.view().released,null);
  }
});

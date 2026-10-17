'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const iconv = require('iconv-lite');
const c = require('../src/core');
const project = path.resolve('工程 空格', 'demo.uvproj');
const xml = `<Project><Targets><Target><TargetName>STC32G12K128</TargetName><ToolsetName>MCS-251</ToolsetName><TargetOption><TargetCommonOption><Device>STC32G12K128</Device><OutputDirectory>.\\Out_File\\</OutputDirectory><OutputName>demo</OutputName><CreateHexFile>1</CreateHexFile><BeforeMake><RunUserProg1>1</RunUserProg1><UserProg1Name>echo test</UserProg1Name></BeforeMake></TargetCommonOption></TargetOption><Groups><Group><Files><File><FilePath>..\\main.c</FilePath></File><File><FileName>missing</FileName></File></Files></Group></Groups></Target></Targets></Project>`;
function record(type, offset, bytes = []) {
  const data = [bytes.length, offset >> 8, offset & 255, type, ...bytes];
  data.push((-data.reduce((a,b) => a+b, 0)) & 255);
  return ':' + Buffer.from(data).toString('hex').toUpperCase();
}
const hex = lines => Buffer.from(lines.join('\n') + '\n');
const eof = record(1, 0);
test('Keil single target, relative paths and hook detection', () => {
  const t = c.parseProject(xml, project).targets[0];
  assert.equal(t.name, 'STC32G12K128');
  assert.equal(t.toolset, 'MCS-251');
  assert.equal(t.hexPath, path.join(path.dirname(project), 'Out_File', 'demo.hex'));
  assert.equal(t.files.length, 1);
  assert.equal(t.files[0], path.resolve(path.dirname(project), '..', 'main.c'));
  assert.deepEqual(t.hooks, ['BeforeMake: echo test']);
});
test('multiple targets and XML entities in names', () => {
  const t = '<Target><TargetName>A &amp; B</TargetName></Target>';
  assert.equal(c.parseProject(`<Project><Targets>${t}${t}</Targets></Project>`, project).targets.length, 2);
  assert.equal(c.parseProject(`<Project><Targets>${t}</Targets></Project>`, project).targets[0].name, 'A & B');
});
test('reject missing targets, invalid XML, DTD and entities', () => {
  for (const input of ['<Project/>', '<Project>', '<!DOCTYPE Project><Project/>', '<!ENTITY x "abc"><Project/>']) assert.throws(() => c.parseProject(input, project));
});
test('GBK and UTF8 decoding', () => {
  assert.equal(c.decode(iconv.encode('编译成功', 'gbk')), '编译成功');
  assert.equal(c.decode(Buffer.from('编译成功')), '编译成功');
});
test('build arguments retain spaces as literal arguments and reject ARM', () => {
  const t = c.parseProject(xml, project).targets[0];
  assert.deepEqual(c.buildArgs(project, t, 'a log.txt'), ['-b', project, '-t', t.name, '-o', 'a log.txt']);
  assert.equal(c.buildArgs(project, t, 'log', true)[0], '-r');
  assert.throws(() => c.buildArgs(project, {toolset:'ARM-ADS'}, 'log'));
});
test('build outcome requires exit code AND successful summary', () => {
  assert.equal(c.buildSucceeded(0, 'demo - 0 Error(s), 0 Warning(s).'), true);
  assert.equal(c.buildSucceeded(1, 'demo - 0 Error(s), 2 Warning(s).'), true);
  for (const [code, text] of [[2,'0 Error(s)'], [null,'0 Error(s)'], [0,''], [0,'1 Error(s)'], [0,'0 Error(s)\nTarget not created'], [0,'0 Error(s)\n*** ERROR C141'], [0,'1 Error(s)\n0 Error(s)']]) assert.equal(c.buildSucceeded(code,text), false);
});
test('C251 diagnostic styles produce zero-based clickable locations', () => {
  const items = c.parseDiagnostics('../main.c(12): error C141: syntax error\n*** WARNING C280 IN LINE 20 OF ../other.c: unused\nmain.c(3,5): warning C123: note', path.dirname(project));
  assert.equal(items.length, 3);
  assert.equal(items[0].line, 11); assert.equal(items[0].severity, 'error');
  assert.equal(items[1].line, 19); assert.equal(items[1].code, 'C280');
  assert.equal(items[2].column, 4);
});
test('HEX retains FF0000 addresses and counts holes', () => {
  const info = c.inspectHex(hex([record(4,0,[0,255]), record(0,0,[1,2]), record(0,4,[3]), eof]));
  assert.equal(info.min, 0xff0000); assert.equal(info.max, 0xff0004);
  assert.equal(info.bytes, 3); assert.equal(info.holes, 2);
  assert.deepEqual(info.banks,[255]); assert.equal(info.flashEnabled,false);
});
test('HEX does not alias identical offsets in different banks', () => {
  const info = c.inspectHex(hex([record(4,0,[0,254]),record(0,0,[1]),record(4,0,[0,255]),record(0,0,[2]),eof]));
  assert.equal(info.bytes,2); assert.deepEqual(info.banks,[254,255]);
});
test('HEX segment addresses and start addresses', () => {
  const info = c.inspectHex(hex([record(2,0,[0x10,0]),record(0,2,[3]),record(3,0,[0,0,0,0]),record(5,0,[0,0,0,0]),eof]));
  assert.equal(info.min,0x10002);
});
test('HEX rejects checksum, length, overlap, missing EOF, bad record and crossing', () => {
  const cases = [
    [':0100000001FF',eof], [':0200000001FD',eof], [record(0,0,[1]),record(0,0,[2]),eof],
    [record(0,0,[1])], [eof], [record(0,0,[1]),eof,record(0,1,[2])],
    [record(0,65535,[1,2]),eof], [record(4,1,[0,255]),eof], [record(6,0),eof], ['garbage',eof]
  ];
  for (const lines of cases) assert.throws(() => c.inspectHex(hex(lines)));
});
test('HEX rejects high-bit bytes and oversized files', () => {
  const bad = hex([record(0,0,[1]),eof]); bad[0] |= 0x80;
  assert.throws(() => c.inspectHex(bad), /ASCII/);
  assert.throws(() => c.inspectHex(Buffer.alloc(8*1024*1024+1)), /过大/);
});
test('flashing is explicitly blocked', () => assert.match(c.FLASH_BLOCK_REASON, /不包含烧录执行路径/));

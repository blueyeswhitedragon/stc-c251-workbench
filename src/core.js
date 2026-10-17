'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const iconv = require('iconv-lite');

const FLASH_BLOCK_REASON = '此 MVP 不包含烧录执行路径：STC32 复位脚、EEPROM、地址映射和写后校验尚未核实。不会擦除、写入或修改硬件配置。';
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
function decode(buffer, encoding = 'auto') {
  if (encoding !== 'auto') return iconv.decode(buffer, encoding);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return iconv.decode(buffer, 'gbk'); }
}
function projectPath(base, name) {
  return path.resolve(base, String(name || '').replace(/[\\/]/g, path.sep));
}
function parseProject(text, filename) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持含 DTD/ENTITY 的工程文件。');
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`工程 XML 无效：${valid.err.msg}`);
  const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(text);
  const targets = list(xml?.Project?.Targets?.Target).map(target => {
    const common = target.TargetOption?.TargetCommonOption || {};
    const hooks = [];
    for (const group of ['BeforeCompile', 'BeforeMake', 'AfterMake']) {
      for (const number of [1, 2]) {
        const h = common[group];
        if (h && String(h[`RunUserProg${number}`]) === '1') hooks.push(`${group}: ${h[`UserProg${number}Name`] || '(空)'}`);
      }
    }
    const base = path.dirname(filename);
    const outputDir = projectPath(base, common.OutputDirectory || '.');
    const outputName = String(common.OutputName || '');
    return {
      name: String(target.TargetName || ''), toolset: String(target.ToolsetName || ''),
      device: String(common.Device || ''), outputDir, outputName,
      hexEnabled: String(common.CreateHexFile) === '1',
      hexPath: outputName ? path.join(outputDir, /\.hex$/i.test(outputName) ? outputName : `${outputName}.hex`) : null,
      hooks,
      files: list(target.Groups?.Group).flatMap(group => list(group.Files?.File).filter(file => file.FilePath).map(file => projectPath(base, file.FilePath)))
    };
  });
  if (!targets.length || targets.some(t => !t.name)) throw new Error('没有找到有效的 Keil Target。');
  return { filename: path.resolve(filename), targets };
}
function buildArgs(project, target, logPath, rebuild = false) {
  if (!/MCS.?251|C251/i.test(target.toolset)) throw new Error(`本 MVP 仅支持 C251；当前工具链为 ${target.toolset}`);
  return [rebuild ? '-r' : '-b', project, '-t', target.name, '-o', logPath];
}
function parseDiagnostics(text, base) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(?:\*+\s*)?(fatal error|error|warning)\s+([A-Z]?\d+)?\s*:?\s*(.*)$/i);
    if (m) {
      result.push({ file: projectPath(base, m[1].replace(/^['"]|['"]$/g, '')), line: Math.max(0, Number(m[2]) - 1), column: Math.max(0, Number(m[3] || 1) - 1), severity: /error/i.test(m[4]) ? 'error' : 'warning', code: m[5] || '', message: m[6] });
      continue;
    }
    m = line.match(/\*+\s*(ERROR|WARNING)\s+(\w+)\s+IN LINE\s+(\d+)\s+OF\s+(.+?)\s*:\s*(.*)$/i);
    if (m) result.push({ file: projectPath(base, m[4]), line: Math.max(0, Number(m[3]) - 1), column: 0, severity: m[1].toLowerCase(), code: m[2], message: m[5] });
  }
  return result;
}
function buildSucceeded(exitCode, text) {
  const summaries = [...text.matchAll(/(\d+)\s+Error\(s\)/gi)];
  return [0, 1].includes(exitCode) && summaries.length > 0 && summaries.every(m => Number(m[1]) === 0) && !/Target not created|FATAL ERROR|error\s+[CLAB]\d+/i.test(text);
}
function inspectHex(buffer) {
  if (buffer.length > 8 * 1024 * 1024) throw new Error('HEX 文件过大（上限 8 MiB）。');
  if (buffer.some(byte => byte > 127)) throw new Error('HEX 必须为 ASCII 文本。');
  const memory = new Map(); const counts = {}; let base = 0; let eof = false;
  for (const [index, raw] of buffer.toString('ascii').split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue;
    const fail = message => { throw new Error(`HEX 第 ${index + 1} 行：${message}`); };
    if (eof) fail('EOF 后仍有数据');
    if (!/^:(?:[0-9a-fA-F]{2})+$/.test(line)) fail('格式错误');
    const r = Buffer.from(line.slice(1), 'hex');
    if (r.length < 5 || r.length !== r[0] + 5) fail('长度错误');
    if (r.reduce((a,b) => a+b, 0) % 256) fail('校验和错误');
    const n = r[0], offset = r.readUInt16BE(1), type = r[3];
    counts[type] = (counts[type] || 0) + 1;
    if (type === 0) {
      if (offset + n > 65536) fail('跨越 64 KiB 边界');
      for (let i=0; i<n; i++) {
        const address = base + offset + i;
        if (address > 0xffffffff || memory.has(address)) fail('地址溢出或重叠');
        memory.set(address, r[4+i]);
      }
      if (memory.size > 1024 * 1024) fail('数据量超过检查上限');
    } else if (type === 1) {
      if (n !== 0 || offset !== 0) fail('EOF 格式错误'); eof = true;
    } else if ([2,4].includes(type)) {
      if (n !== 2 || offset !== 0) fail('扩展地址格式错误');
      base = r.readUInt16BE(4) * (type === 4 ? 65536 : 16);
    } else if ([3,5].includes(type)) {
      if (n !== 4 || offset !== 0) fail('启动地址格式错误');
    } else fail('不支持的记录类型');
  }
  if (!eof || !memory.size) throw new Error('HEX 缺少 EOF 或程序数据。');
  const addresses = [...memory.keys()].sort((a,b) => a-b);
  const min = addresses[0], max = addresses.at(-1);
  return { bytes: memory.size, min, max, holes: max-min+1-memory.size, banks: [...new Set(addresses.map(a => Math.floor(a/65536)))], counts, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), flashEnabled: false };
}
module.exports = { FLASH_BLOCK_REASON, decode, parseProject, buildArgs, parseDiagnostics, buildSucceeded, inspectHex };

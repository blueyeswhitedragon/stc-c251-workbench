'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function isExecutable(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

function candidateKeilPaths(env = process.env) {
  const roots = [
    'C:\\Keil_v5\\UV4\\UV4.exe',
    'C:\\Keil\\UV4\\UV4.exe',
    'C:\\Keil_v5\\UV4.exe',
    'C:\\Keil\\UV4.exe',
    'C:\\STC\\UV4\\UV4.exe',
    'C:\\STC\\UV4.exe',
    'C:\\Program Files\\Keil\\UV4\\UV4.exe',
    'C:\\Program Files (x86)\\Keil\\UV4\\UV4.exe',
    'C:\\Program Files\\STC\\UV4\\UV4.exe',
    'C:\\Program Files (x86)\\STC\\UV4\\UV4.exe'
  ];
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) {
      roots.push(path.join(env[key], 'Keil', 'UV4', 'UV4.exe'));
      roots.push(path.join(env[key], 'STC', 'UV4', 'UV4.exe'));
    }
  }
  return [...new Set(roots)];
}

async function findKeil(specified = '', env = process.env) {
  const candidates = specified.trim() ? [specified.trim()] : candidateKeilPaths(env);
  for (const candidate of candidates) if (await isExecutable(candidate)) return path.normalize(candidate);
  return null;
}

module.exports = { candidateKeilPaths, findKeil, isExecutable };

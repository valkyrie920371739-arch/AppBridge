'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

function parseConfig(text) {
  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator > 1) result[line.slice(1, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function inspectArchive(archive, readFile) {
  const read = (entry) => readFile(path.join(archive, ...entry.split('/'))).toString('utf8');
  const manifest = JSON.parse(read('package.json'));
  if (manifest.name !== 'tyranogame' || manifest.main !== 'main.js') {
    throw new Error('此版本支持已核实的 TyranoScript 5 游戏包。这个文件的入口与支持格式不一致。');
  }
  const main = read('main.js');
  const preload = read('preload.js');
  const html = read('index.html');
  const libs = read('tyrano/libs.js');
  if (!main.includes('TyranoErectron') || !preload.includes('studio_api') ||
      !html.includes('./tyrano/plugins/kag/kag.js') || !libs.includes('/Contents/Resources/app.asar')) {
    throw new Error('这个游戏包的运行接口与已核实样本不同，需要单独检查后适配。');
  }
  const config = parseConfig(read('data/system/Config.tjs'));
  for (const key of ['projectID', 'System.title', 'scWidth', 'scHeight', 'configSave']) {
    if (!config[key]) throw new Error(`游戏配置缺少 ${key}，无法继续导入。`);
  }
  if (config.configSave !== 'file') throw new Error('当前版本只验证了文件存档模式。');
  for (const entry of ['fs-extra', 'asar', 'adm-zip', 'csv-parse', 'csv-stringify']) {
    read(`node_modules/${entry}/package.json`);
  }
  const width = Number(config.scWidth);
  const height = Number(config.scHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || width > 7680 || height > 4320) {
    throw new Error('游戏窗口尺寸超出此版本支持范围。');
  }
  return { title: config['System.title'], projectID: config.projectID, width, height,
    engine: 'TyranoScript 5', manifestVersion: manifest.version,
    interfaceHash: crypto.createHash('sha256').update(main).update(preload).update(libs).digest('hex') };
}

function managedArchive(profile, platform) {
  return platform === 'darwin'
    ? path.join(profile, 'Game.app', 'Contents', 'Resources', 'app.asar')
    : path.join(profile, 'resources', 'app.asar');
}

module.exports = { parseConfig, inspectArchive, managedArchive };

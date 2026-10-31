'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Recognition only: a directory layout does not establish runtime compatibility.
// Inspect known locations, never recursively enumerate a complete game folder.
const MAX_DIRECTORY_ENTRIES = 1024;
const MAX_DIRECTORIES = 128;
const MAX_UNREAL_PROJECTS = 24;
const MAX_MANIFEST_BYTES = 64 * 1024;
const NAMES = Object.freeze({ unity: 'Unity', unreal: 'Unreal Engine', godot: 'Godot', renpy: "Ren’Py", 'rpg-maker-mv': 'RPG Maker MV', 'rpg-maker-mz': 'RPG Maker MZ', tyrano: 'TyranoScript', unknown: 'Windows' });

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw new Error(`${label}必须是明确的绝对路径。`);
  return path.resolve(value);
}

function within(root, value) {
  const relative = path.relative(root, value);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ordinary(value, directory, label) {
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error(`${label}必须是普通${directory ? '文件夹' : '文件'}，不能是符号链接。`);
  return stat;
}

class Scope {
  constructor(root) { this.root = root; this.cache = new Map(); this.warnings = new Set(); }
  relative(value) { return path.relative(this.root, value).split(path.sep).join('/') || '.'; }
  entries(directory) {
    if (!directory || !within(this.root, directory)) return [];
    if (this.cache.has(directory)) return this.cache.get(directory);
    if (this.cache.size >= MAX_DIRECTORIES) { this.warnings.add('已达到引擎识别的目录数量上限，部分特征未检查。'); return []; }
    const entries = [];
    this.cache.set(directory, entries);
    let handle;
    try {
      ordinary(directory, true, '引擎检查目录');
      if (!within(this.root, fs.realpathSync(directory))) return entries;
      handle = fs.opendirSync(directory);
      let entry;
      while ((entry = handle.readSync())) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          entries.length = 0;
          this.warnings.add('部分文件夹项目过多，已跳过以限制引擎检查范围。');
          break;
        }
        entries.push(entry);
      }
    } catch { this.warnings.add('部分文件无法读取，引擎识别结果可能不完整。'); }
    finally { if (handle) handle.closeSync(); }
    return entries;
  }
  find(parent, name, type) {
    if (!parent) return null;
    const matches = this.entries(parent).filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (matches.length > 1) { this.warnings.add('发现仅大小写不同的重复路径，已跳过不明确的引擎特征。'); return null; }
    const entry = matches[0];
    if (!entry || entry.isSymbolicLink() || !(type === 'directory' ? entry.isDirectory() : entry.isFile())) return null;
    const result = path.join(parent, entry.name);
    try {
      const stat = fs.lstatSync(result);
      if (stat.isSymbolicLink() || !(type === 'directory' ? stat.isDirectory() : stat.isFile()) || !within(this.root, fs.realpathSync(result))) return null;
      return result;
    } catch { return null; }
  }
  at(parent, segments, type = 'file') {
    for (let i = 0; i < segments.length; i++) {
      parent = this.find(parent, segments[i], i === segments.length - 1 ? type : 'directory');
      if (!parent) return null;
    }
    return parent;
  }
  firstFile(directory, matches) {
    for (const entry of this.entries(directory)) {
      if (entry.isFile() && !entry.isSymbolicLink() && matches(entry.name)) {
        const file = this.find(directory, entry.name, 'file');
        if (file) return file;
      }
    }
    return null;
  }
  read(file, maximum, { head = false } = {}) {
    if (!file) return null;
    let fd;
    try {
      const before = ordinary(file, false, '引擎检查文件');
      if (!within(this.root, fs.realpathSync(file))) return null;
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const current = fs.fstatSync(fd);
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || !within(this.root, fs.realpathSync(file))) return null;
      if (!head && current.size > maximum) { this.warnings.add('部分配置文件过大，已跳过以限制引擎检查范围。'); return null; }
      const data = Buffer.alloc(Math.min(current.size, maximum));
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      return data.subarray(0, offset);
    } catch { this.warnings.add('部分配置文件无法读取，引擎识别结果可能不完整。'); return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

function inferredUnrealRoot(directory) {
  // Only the standard Project/Binaries/Win64 (or Win32) entry layout can
  // justify looking above an explicitly selected entry's own folder.
  if (!/^win(?:32|64)$/i.test(path.basename(directory)) || path.basename(path.dirname(directory)).toLowerCase() !== 'binaries') return null;
  const project = path.dirname(path.dirname(directory));
  const candidate = path.dirname(project);
  const home = fs.realpathSync(os.homedir());
  const broad = new Set([path.parse(candidate).root, home, ...['Desktop', 'Documents', 'Downloads', 'Library', 'Applications'].map((name) => path.join(home, name))]);
  if (broad.has(candidate) || candidate === project || candidate === path.dirname(home)) return null;
  try {
    ordinary(candidate, true, '打包程序目录');
    // Do not promote a disk's mount root into an application resource root.
    if (fs.statSync(candidate).dev !== fs.statSync(path.dirname(candidate)).dev) return null;
    const scope = new Scope(candidate);
    // Packaged games may have only Engine/Binaries/ThirdParty: the selected
    // project's Win64/Win32 binary and Paks already provide the other evidence.
    const engine = scope.at(candidate, ['Engine', 'Binaries'], 'directory');
    const paks = scope.at(project, ['Content', 'Paks'], 'directory');
    const pak = scope.firstFile(paks, (name) => /\.(?:pak|utoc|ucas)$/i.test(name));
    return engine && pak ? candidate : null;
  } catch { return null; }
}

function detectEngine(exePath, { rootDirectory } = {}) {
  const input = absolutePath(exePath, 'Windows 程序路径');
  ordinary(input, false, 'Windows 程序入口');
  const executable = fs.realpathSync(input);
  const directory = path.dirname(executable);
  const chosenRoot = absolutePath(rootDirectory === undefined ? inferredUnrealRoot(directory) || path.dirname(input) : rootDirectory, '程序资源目录');
  ordinary(chosenRoot, true, '程序资源目录');
  const root = fs.realpathSync(chosenRoot);
  if (!within(root, executable)) throw new Error('程序入口必须位于指定的程序资源目录内。');
  const stem = path.basename(input).replace(/\.exe$/i, '');
  const scope = new Scope(root);
  const candidates = [];
  const add = (id, variant, score, files, warnings = [], engineVersion = null) => candidates.push({ id, variant, score, engineVersion, evidence: [...new Set(files.filter(Boolean).map((file) => scope.relative(file)))], warnings });

  const data = scope.find(directory, `${stem}_Data`, 'directory');
  const player = scope.find(directory, 'UnityPlayer.dll', 'file');
  const assembly = scope.find(directory, 'GameAssembly.dll', 'file');
  const mono = scope.find(directory, 'MonoBleedingEdge', 'directory') || scope.at(data, ['Mono'], 'directory') || scope.at(data, ['Managed'], 'directory');
  const manager = scope.at(data, ['globalgamemanagers']) || scope.at(data, ['mainData']);
  const metadata = scope.at(data, ['il2cpp_data', 'Metadata', 'global-metadata.dat']);
  if (player || (data && (manager || mono || metadata))) {
    const ambiguous = Boolean(assembly && mono);
    const variant = ambiguous ? null : assembly ? 'il2cpp' : mono ? 'mono' : null;
    add('unity', variant, data && (player || manager || metadata) ? 5 : player && (assembly || mono) ? 4 : player ? 2 : 4,
      [player, data, assembly, mono, manager, metadata], ambiguous ? ['同时发现 Mono 与 IL2CPP 特征，未自动选择脚本后端。'] : []);
  }

  // Godot reads the standalone PCK header as magic, pack format, major, minor,
  // patch (five little-endian uint32s). Embedded PCKs are deliberately not scanned.
  // https://github.com/godotengine/godot/blob/4.4/core/io/file_access_pack.cpp
  const pck = scope.find(directory, `${stem}.pck`, 'file');
  const header = scope.read(pck, 20, { head: true });
  if (header?.length === 20 && header.toString('ascii', 0, 4) === 'GDPC') {
    const format = header.readUInt32LE(4), major = header.readUInt32LE(8);
    if (format > 0 && major > 0 && major < 100) {
      const known = format <= 3 && [3, 4].includes(major);
      add('godot', known ? `godot-${major}` : null, 5, [pck], known ? [] : ['发现 Godot 资源包，但版本尚未识别，保留程序默认启动参数。'], { major, minor: header.readUInt32LE(12), patch: header.readUInt32LE(16) });
    }
  }

  const renpy = scope.find(directory, 'renpy', 'directory');
  const renpyCode = scope.at(renpy, ['__init__.py']) || scope.at(renpy, ['bootstrap.py']);
  const renpyGame = scope.find(directory, 'game', 'directory');
  const renpyLib = scope.find(directory, 'lib', 'directory');
  if (renpyCode && renpyGame && renpyLib) add('renpy', null, 5, [renpyCode, renpyGame, renpyLib]);

  // A manifest is only data: never require/import any selected program's JS.
  for (const packageRoot of [directory, scope.find(directory, 'www', 'directory')].filter(Boolean)) {
    const packageFile = scope.find(packageRoot, 'package.json', 'file');
    const bytes = scope.read(packageFile, MAX_MANIFEST_BYTES);
    if (!bytes) continue;
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.main !== 'string') continue;
    const main = manifest.main.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!['index.html', 'www/index.html', 'main.js'].includes(main)) continue;
    const entry = scope.at(packageRoot, main.split('/'));
    if (!entry) continue;
    const webRoot = main === 'www/index.html' ? scope.find(packageRoot, 'www', 'directory') : packageRoot;
    const mv = scope.at(webRoot, ['js', 'rpg_core.js']);
    const mz = scope.at(webRoot, ['js', 'rmmz_core.js']);
    if (main !== 'main.js') {
      if (mv) add('rpg-maker-mv', null, 5, [packageFile, entry, mv]);
      if (mz) add('rpg-maker-mz', null, 5, [packageFile, entry, mz]);
    }
    const tyrano = scope.at(webRoot, ['tyrano', 'plugins', 'kag', 'kag.js']);
    if (tyrano && (main !== 'main.js' || manifest.name === 'tyranogame')) add('tyrano', null, 5, [packageFile, entry, tyrano]);
  }

  // Unreal layouts differ between releases. Require packaged resources together
  // with a project binary/Engine layout; a *-Shipping.exe name alone proves nothing.
  const containers = new Set([directory, root]);
  let ancestor = directory;
  for (let depth = 0; depth < 4 && ancestor !== root; depth++) {
    ancestor = path.dirname(ancestor);
    if (!within(root, ancestor)) break;
    containers.add(ancestor);
  }
  const rootChildren = scope.entries(root).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (rootChildren.length > MAX_UNREAL_PROJECTS) scope.warnings.add('顶层文件夹较多，Unreal 项目布局仅检查固定数量的候选目录。');
  for (const child of rootChildren.slice(0, MAX_UNREAL_PROJECTS)) {
    const candidate = scope.find(root, child.name, 'directory');
    if (candidate) containers.add(candidate);
  }
  const engineBinaries = scope.at(root, ['Engine', 'Binaries'], 'directory');
  for (const container of containers) {
    const paks = scope.at(container, ['Content', 'Paks'], 'directory');
    const pak = scope.firstFile(paks, (name) => /\.(?:pak|utoc|ucas)$/i.test(name));
    if (!pak) continue;
    const binaries = scope.at(container, ['Binaries', 'Win64'], 'directory') || scope.at(container, ['Binaries', 'Win32'], 'directory');
    const binary = scope.firstFile(binaries, (name) => /-shipping\.exe$/i.test(name) || path.join(binaries, name) === executable);
    if (binary || engineBinaries) add('unreal', null, 5, [pak, binary, engineBinaries]);
  }

  const ordered = candidates.sort((a, b) => b.score - a.score);
  const selected = ordered[0];
  if (!selected) return { id: 'unknown', name: NAMES.unknown, variant: null, engineVersion: null, rootDirectory: root, evidence: [], confidence: 'unknown', warnings: [...scope.warnings] };
  const conflicting = ordered.filter((candidate) => candidate.score === selected.score && candidate.id !== selected.id);
  if (conflicting.length) return { id: 'unknown', name: NAMES.unknown, variant: null, engineVersion: null, rootDirectory: root, evidence: [...new Set([selected, ...conflicting].flatMap((candidate) => candidate.evidence))], confidence: 'ambiguous', warnings: [...scope.warnings, '同时发现多个引擎的特征，保留程序默认启动方式。'] };
  return { id: selected.id, name: NAMES[selected.id], variant: selected.variant, engineVersion: selected.engineVersion, rootDirectory: root, evidence: selected.evidence, confidence: selected.score >= 5 ? 'high' : selected.score >= 4 ? 'medium' : 'low', warnings: [...scope.warnings, ...selected.warnings] };
}

module.exports = { detectEngine };

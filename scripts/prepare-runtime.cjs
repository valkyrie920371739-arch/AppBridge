#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = fs.realpathSync(path.join(__dirname, '..'));
const runtimeOutput = path.join(root, 'runtime');
const manifestOutput = path.join(root, 'runtime-manifest.json');
const assets = [
  {
    component: 'Sikarugir Wine engine', version: '10.0 revision 8', role: 'Wine binaries, Windows DLLs and macOS driver',
    archive: '.cache/WS12WineSikarugir10.0_8.tar.xz', sizeBytes: 166321980,
    sha256: '2a6bcf2a3bf13cddf825599b6bc1e3659cbf71e1282c6d77141a92f6ac8d4c68',
    url: 'https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir10.0_8.tar.xz',
    releaseUrl: 'https://github.com/Sikarugir-App/Engines/releases/tag/v1.0',
    apiUrl: 'https://api.github.com/repos/Sikarugir-App/Engines/releases/assets/604320750',
  },
  {
    component: 'Wine Staging support libraries', version: '11.20', role: 'Top-level macOS support dylibs only; Wine engine not used',
    archive: '.cache/wine-staging-11.20-verified.tar.xz', sizeBytes: 227975304,
    sha256: '4df858c5e72920deaf123cbc29fa2b9e64c23bcf2dea59e0a7047b879b9cd952',
    url: 'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.20/wine-staging-11.20-osx64.tar.xz',
    releaseUrl: 'https://github.com/Gcenx/macOS_Wine_builds/releases/tag/11.20',
    apiUrl: 'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/assets/687305161',
  },
  {
    component: 'DXMT builtin', version: '0.80',
    archive: '.cache/dxmt-v0.80-verified.tar.gz', sizeBytes: 18681669,
    sha256: '8f260e36b5739e68f3bad613381441385c4dc7b85b78ba8de653d5a6a264529d',
    url: 'https://github.com/3Shain/dxmt/releases/download/v0.80/dxmt-v0.80-builtin.tar.gz',
    releaseUrl: 'https://github.com/3Shain/dxmt/releases/tag/v0.80',
    apiUrl: 'https://api.github.com/repos/3Shain/dxmt/releases/assets/403345414',
  },
];

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function downloadCommand(asset) {
  // This text is guidance only; downloads are never executed through a shell.
  return `python3 scripts/download-asset.py "${asset.apiUrl}" "${asset.archive}" ${asset.sizeBytes} ${asset.sha256}`;
}

function verifyArchives() {
  const failures = [];
  for (const asset of assets) {
    const archive = path.join(root, asset.archive);
    if (!fs.existsSync(archive)) failures.push(`缺少 ${asset.archive}\n${downloadCommand(asset)}`);
    else if (!fs.statSync(archive).isFile() || fs.statSync(archive).size !== asset.sizeBytes || sha256(archive) !== asset.sha256) {
      failures.push(`${asset.archive} 校验失败，请重新下载：\n${downloadCommand(asset)}`);
    }
  }
  if (failures.length) throw new Error(`请先在项目目录运行以下下载命令，再重新准备组件：\n\n${failures.join('\n\n')}`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} 失败：${(result.stderr || result.stdout || result.signal || result.status).toString().trim()}`);
  return result.stdout.trim();
}

function assertContainedSymlinks(boundary, directory = boundary) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) assertContainedSymlinks(boundary, file);
    else if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      if (target !== boundary && !target.startsWith(`${boundary}${path.sep}`)) throw new Error(`组件包含指向目录外的符号链接：${file}`);
      if (fs.existsSync(file)) {
        const real = fs.realpathSync(file);
        if (real !== boundary && !real.startsWith(`${boundary}${path.sep}`)) throw new Error(`组件包含间接指向目录外的符号链接：${file}`);
      }
    }
  }
}

function requireDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`组件目录布局无效：${directory}`);
}

function main() {
  if (process.platform !== 'darwin') throw new Error('此运行组件需要在 macOS 上准备和验证。');
  if (process.argv.length > 2) throw new Error('此脚本不接受路径或其他参数；输入和输出均固定在项目目录。');
  // Nothing is extracted or replaced until all three pinned release assets pass.
  verifyArchives();
  if (fs.existsSync(runtimeOutput)) requireDirectory(runtimeOutput);
  const stagingRoot = fs.mkdtempSync(path.join(root, '.appbridge-runtime-'));
  const stagedRuntime = path.join(stagingRoot, 'runtime');
  const stagedEngine = path.join(stagingRoot, 'sikarugir');
  const stagedSupport = path.join(stagingRoot, 'support');
  const stagedDxmt = path.join(stagingRoot, 'dxmt');
  const stagedManifest = path.join(stagingRoot, 'runtime-manifest.json');
  let preserveStaging = false;
  try {
    fs.mkdirSync(stagedRuntime);
    fs.mkdirSync(stagedEngine);
    fs.mkdirSync(stagedSupport);
    fs.mkdirSync(stagedDxmt);
    console.log('三个组件校验通过，正在准备独立运行目录…');
    run('/usr/bin/tar', ['-xf', path.join(root, assets[0].archive), '-C', stagedEngine]);
    run('/usr/bin/tar', ['-xf', path.join(root, assets[1].archive), '-C', stagedSupport]);
    run('/usr/bin/tar', ['-xf', path.join(root, assets[2].archive), '-C', stagedDxmt]);
    assertContainedSymlinks(stagedEngine);
    assertContainedSymlinks(stagedSupport);
    assertContainedSymlinks(stagedDxmt);

    const engineRoot = path.join(stagedEngine, 'wswine.bundle');
    const supportRoot = path.join(stagedSupport, 'Wine Staging.app', 'Contents', 'Resources', 'wine', 'lib');
    const wineApp = path.join(stagedRuntime, 'AppBridgeWine.app');
    const wineContents = path.join(wineApp, 'Contents');
    const wineBin = path.join(wineContents, 'MacOS');
    const supportLib = path.join(wineContents, 'lib');
    const wineLib = path.join(supportLib, 'wine');
    const dxmtRoot = path.join(stagedDxmt, 'v0.80');
    for (const directory of [engineRoot, path.join(engineRoot, 'bin'), path.join(engineRoot, 'lib'), path.join(engineRoot, 'share'), supportRoot, dxmtRoot]) requireDirectory(directory);
    fs.mkdirSync(wineContents, { recursive: true });
    run('/usr/bin/ditto', [path.join(engineRoot, 'bin'), wineBin]);
    run('/usr/bin/ditto', [path.join(engineRoot, 'lib'), supportLib]);
    run('/usr/bin/ditto', [path.join(engineRoot, 'share'), path.join(wineContents, 'share')]);
    // Wine resolves share data through lib/wine/../../bin/../share. Retain the
    // expected bin component while using a conventional macOS executable path.
    fs.symlinkSync('MacOS', path.join(wineContents, 'bin'));
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AppBridge Runtime</string>
<key>LSUIElement</key><true/>
<key>CFBundleIdentifier</key><string>local.appbridge.runtime</string>
<key>CFBundleExecutable</key><string>wine</string>
<key>CFBundleVersion</key><string>10.0.8</string>
<key>CFBundleShortVersionString</key><string>10.0.8</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`;
    const infoFile = path.join(wineContents, 'Info.plist');
    fs.writeFileSync(infoFile, plist, { mode: 0o644 });
    run('/usr/bin/plutil', ['-lint', infoFile]);
    assertContainedSymlinks(stagedRuntime);
    requireDirectory(wineLib);

    const files = [];
    const supportFiles = [];
    const dylibs = fs.readdirSync(supportRoot, { withFileTypes: true }).filter((entry) => entry.name.endsWith('.dylib') && (entry.isFile() || entry.isSymbolicLink())).sort((a, b) => a.name.localeCompare(b.name));
    if (!dylibs.length) throw new Error('Wine 11.20 归档中没有找到顶层支持 dylib。');
    for (const entry of dylibs) {
      const source = path.join(supportRoot, entry.name);
      const destination = path.join(supportLib, entry.name);
      if (fs.existsSync(destination)) throw new Error(`支持库与引擎现有文件冲突：${entry.name}`);
      // Resolve the archive's version aliases into local files. This keeps every
      // copied library within the new bundle and does not copy its Wine engine.
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
      const sourceHash = sha256(source);
      if (sha256(destination) !== sourceHash) throw new Error(`支持库复制校验失败：${entry.name}`);
      const record = {
        file: path.relative(stagedRuntime, destination).split(path.sep).join('/'),
        component: 'Wine Staging 11.20 support dylibs', sha256: sourceHash, sizeBytes: fs.statSync(destination).size,
      };
      supportFiles.push(record);
      files.push(record);
    }

    const overlay = ['x86_64-unix/winemetal.so'];
    for (const architecture of ['x86_64-windows', 'i386-windows']) {
      for (const dll of ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll', 'winemetal.dll']) overlay.push(`${architecture}/${dll}`);
    }
    for (const entry of overlay) {
      const source = path.join(dxmtRoot, ...entry.split('/'));
      const destination = path.join(wineLib, ...entry.split('/'));
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`DXMT 文件布局无效：${entry}`);
      requireDirectory(path.dirname(destination));
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error(`覆盖目标不能是符号链接：${entry}`);
      // Copy only these nine files. All other Wine DLLs and Unix libraries stay.
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, sourceStat.mode & 0o777);
      const sourceHash = sha256(source);
      if (sha256(destination) !== sourceHash) throw new Error(`组件复制校验失败：${entry}`);
      files.push({
        file: path.relative(stagedRuntime, destination).split(path.sep).join('/'),
        component: 'DXMT builtin 0.80', sha256: sourceHash, sizeBytes: sourceStat.size,
      });
    }
    assertContainedSymlinks(stagedRuntime);
    const wineExecutable = path.join(wineBin, 'wine');
    const macDriver = path.join(wineLib, 'x86_64-unix', 'winemac.so');
    const symbols = run('/usr/bin/nm', ['-gU', macDriver], { maxBuffer: 8 * 1024 * 1024 });
    if (!symbols.split(/\r?\n/).some((line) => /\s_macdrv_functions$/.test(line.trim()))) {
      throw new Error('Wine macOS 驱动未导出 DXMT 所需的 _macdrv_functions，现有 runtime 保持原样。');
    }
    fs.accessSync(wineExecutable, fs.constants.R_OK | fs.constants.X_OK);
    let version;
    try {
      version = run(wineExecutable, ['--version'], {
        timeout: 15000, maxBuffer: 65536,
        env: {
          ...process.env,
          PATH: [wineBin, process.env.PATH || '/usr/bin:/bin'].join(path.delimiter),
          DYLD_FALLBACK_LIBRARY_PATH: [supportLib, process.env.DYLD_FALLBACK_LIBRARY_PATH, '/usr/local/lib', '/usr/lib'].filter(Boolean).join(path.delimiter),
          DYLD_LIBRARY_PATH: [supportLib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
        },
      });
    } catch (error) {
      throw new Error(`Wine 版本检测未通过，现有 runtime 保持原样。Apple 芯片 Mac 还需能执行 Intel 程序。\n${error.message}`);
    }
    if (!/^wine-10\.0(?:[.\s(]|$)/.test(version) || /[\r\n]/.test(version)) throw new Error(`Wine 返回了非预期版本，现有 runtime 保持原样：${version}`);
    files.push({
      file: path.relative(stagedRuntime, wineExecutable).split(path.sep).join('/'),
      component: 'Sikarugir Wine 10.0 revision 8', sha256: sha256(wineExecutable), sizeBytes: fs.statSync(wineExecutable).size,
    });
    files.push({
      file: path.relative(stagedRuntime, macDriver).split(path.sep).join('/'),
      component: 'Sikarugir Wine 10.0 revision 8 macOS driver', sha256: sha256(macDriver), sizeBytes: fs.statSync(macDriver).size,
    });
    const manifest = {
      schemaVersion: 1, preparedAt: new Date().toISOString(),
      architecture: 'x86_64 (Apple Silicon requires Rosetta)',
      wineVersion: version, graphics: 'DXMT builtin 0.80',
      locallySigned: false,
      assembly: {
        engine: 'Sikarugir Wine 10.0 revision 8 (wswine.bundle bin, lib and share)',
        supportLibraries: 'All top-level *.dylib from Gcenx Wine Staging 11.20 lib; Wine 11.20 engine and Windows DLLs are excluded',
        graphicsOverlay: 'Nine DXMT builtin 0.80 files, preserving all other engine DLLs',
        bundleLayout: 'AppBridgeWine.app/Contents/{MacOS,lib,share}; Contents/bin -> MacOS (relative symlink required for Wine data lookup)',
        status: 'Local experimental combination; not an upstream-supported integrated distribution',
      },
      components: assets.map((asset) => ({
        ...asset, officialApiDigest: `sha256:${asset.sha256}`,
        digestSource: asset.apiUrl, archiveVerified: true,
      })),
      overlayFiles: files.filter((file) => file.component.startsWith('DXMT')),
      supportLibraryFiles: supportFiles,
      verifiedFiles: files,
      verification: {
        wineVersionPassed: true, macdrvFunctionsExported: true,
        windowsCommandTested: false, graphicsExecutionTested: false, actualApplicationsTested: false,
        scope: 'This preparation run verifies archive digests, copied files, the driver export and wine --version on the current Mac only. It does not import results from another local test or establish software compatibility.',
      },
    };
    fs.writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    const previousRuntime = path.join(stagingRoot, 'previous-runtime');
    const previousManifest = path.join(stagingRoot, 'previous-runtime-manifest.json');
    let movedRuntime = false;
    let movedManifest = false;
    let publishedRuntime = false;
    try {
      if (fs.existsSync(runtimeOutput)) { fs.renameSync(runtimeOutput, previousRuntime); movedRuntime = true; }
      if (fs.existsSync(manifestOutput)) { fs.renameSync(manifestOutput, previousManifest); movedManifest = true; }
      fs.renameSync(stagedRuntime, runtimeOutput); publishedRuntime = true;
      fs.renameSync(stagedManifest, manifestOutput);
    } catch (error) {
      try {
        if (publishedRuntime) fs.renameSync(runtimeOutput, stagedRuntime);
        if (movedRuntime) fs.renameSync(previousRuntime, runtimeOutput);
        if (movedManifest) fs.renameSync(previousManifest, manifestOutput);
      } catch (restoreError) {
        preserveStaging = true;
        throw new Error(`${error.message}\n自动恢复失败，原组件和记录保留在：${stagingRoot}\n${restoreError.message}`);
      }
      throw error;
    }
    console.log(`组件准备完成：${runtimeOutput}\n${version}\n已覆盖并校验 9 个 DXMT 文件。可继续运行构建脚本进行本机签名。`);
  } finally {
    if (!preserveStaging) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }

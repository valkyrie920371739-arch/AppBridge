#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const projectRoot = fs.realpathSync(path.join(__dirname, '..'));
const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const buildDirectory = path.join(projectRoot, 'build');
const outputApp = path.join(buildDirectory, 'AppBridge.app');
const projectBaseApp = path.join(projectRoot, 'base', 'AppBridge.app');
const electronBaseApp = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
const defaultBaseApp = fs.existsSync(projectBaseApp)
  ? projectBaseApp
  : electronBaseApp;

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} 失败（${result.status ?? result.signal}）：${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function setBundleString(file, key, value) {
  const existing = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8' });
  if (existing.error) throw existing.error;
  const operation = existing.status === 0 ? `Set :${key} ${value}` : `Add :${key} string ${value}`;
  run('/usr/libexec/PlistBuddy', ['-c', operation, file]);
}

function fileHashes(directory, relative = '') {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...fileHashes(file, name));
    else if (entry.isFile()) output.push({ file: name, sha256: digest(file), sizeBytes: fs.statSync(file).size });
    else if (entry.isSymbolicLink()) output.push({ file: name, symbolicLink: fs.readlinkSync(file) });
  }
  return output;
}

function ensureBuildDirectory() {
  if (!fs.existsSync(buildDirectory)) fs.mkdirSync(buildDirectory, { mode: 0o755 });
  const stat = fs.lstatSync(buildDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(buildDirectory) !== buildDirectory) {
    throw new Error('build 必须是本项目中的普通目录，不能是符号链接。');
  }
  if (fs.existsSync(outputApp) && (!fs.lstatSync(outputApp).isDirectory() || fs.lstatSync(outputApp).isSymbolicLink())) {
    throw new Error('build/AppBridge.app 不是普通应用目录，已停止以免改写其他位置。');
  }
}

function copyDirectory(source, destination) {
  if (!fs.statSync(source).isDirectory()) throw new Error(`复制来源不是目录：${source}`);
  // Generated code bundles must not inherit iCloud File Provider identities.
  // Those identities can asynchronously recreate FinderInfo after signing,
  // even when the copied bundle is outside iCloud.
  run('/usr/bin/ditto', ['--noextattr', '--norsrc', source, destination]);
}

function assertContainedSymlinks(root, directory = root) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) assertContainedSymlinks(root, file);
    else if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`应用内的符号链接指向构建目录之外，已停止：${file}`);
      }
      if (fs.existsSync(file)) {
        const resolved = fs.realpathSync(file);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error(`应用内的符号链接间接指向构建目录之外，已停止：${file}`);
        }
      }
    }
  }
}

function main() {
  if (process.platform !== 'darwin') throw new Error('此构建脚本需要在 macOS 上执行。');
  const options = process.argv.slice(2);
  if (options.some((option) => option !== '--skip-sign')) throw new Error('仅支持可选参数 --skip-sign。');
  const skipSign = options.includes('--skip-sign');
  const selectedBase = process.env.APPBRIDGE_BASE_APP || defaultBaseApp;
  if (!path.isAbsolute(selectedBase)) throw new Error('APPBRIDGE_BASE_APP 必须是输入 .app 的绝对路径。');
  if (!fs.existsSync(selectedBase)) {
    throw new Error('未找到 Electron 基座。请先运行 npm ci，或将 APPBRIDGE_BASE_APP 设为已有 Electron .app 的绝对路径。');
  }
  const baseApp = fs.realpathSync(selectedBase);
  if (!baseApp.endsWith('.app') || !fs.statSync(baseApp).isDirectory()) throw new Error('输入必须是有效的 .app 目录。');
  if (baseApp === outputApp || baseApp.startsWith(`${buildDirectory}${path.sep}`) || buildDirectory.startsWith(`${baseApp}${path.sep}`)) {
    throw new Error('输入应用与 build 输出目录不能相互包含。');
  }
  const baseInfo = path.join(baseApp, 'Contents', 'Info.plist');
  fs.accessSync(baseInfo, fs.constants.R_OK);
  const executableName = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', baseInfo]);
  if (!executableName || path.basename(executableName) !== executableName) throw new Error('输入应用的启动入口无效。');
  fs.accessSync(path.join(baseApp, 'Contents', 'MacOS', executableName), fs.constants.R_OK | fs.constants.X_OK);
  const sourceDirectory = path.join(projectRoot, 'src');
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'package.json'), 'utf8'));
  if (sourcePackage.version !== metadata.version) throw new Error('src/package.json 与项目根目录版本不一致，请先更新源码版本。');

  ensureBuildDirectory();
  // Signing must run outside iCloud. Its File Provider automatically restores
  // FinderInfo on app directories even immediately after xattr deletion.
  const stagingDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-build-')));
  const stagedApp = path.join(stagingDirectory, 'AppBridge.app');
  let preserveStaging = false;
  try {
    console.log(`正在构建 AppBridge ${metadata.version}…`);
    copyDirectory(baseApp, stagedApp);
    assertContainedSymlinks(stagedApp);
    const resources = path.join(stagedApp, 'Contents', 'Resources');
    for (const directory of [path.join(stagedApp, 'Contents'), resources]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`应用关键目录不能是符号链接：${directory}`);
    }
    const applicationDirectory = path.join(resources, 'app');
    fs.rmSync(applicationDirectory, { recursive: true, force: true });
    copyDirectory(sourceDirectory, applicationDirectory);
    const stagedInfo = path.join(stagedApp, 'Contents', 'Info.plist');
    if (!fs.lstatSync(stagedInfo).isFile() || fs.lstatSync(stagedInfo).isSymbolicLink()) throw new Error('Info.plist 必须是应用内的普通文件。');
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) setBundleString(stagedInfo, key, metadata.productName);
    setBundleString(stagedInfo, 'CFBundleIdentifier', 'local.appbridge.player');
    for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) setBundleString(stagedInfo, key, metadata.version);
    const appIconSource = path.join(projectRoot, 'assets', 'appbridge.icns');
    const appIconOutput = path.join(resources, 'appbridge.icns');
    const appIconStat = fs.lstatSync(appIconSource);
    if (!appIconStat.isFile() || appIconStat.isSymbolicLink()) throw new Error('AppBridge 图标必须是普通文件。');
    fs.copyFileSync(appIconSource, appIconOutput);
    setBundleString(stagedInfo, 'CFBundleIconFile', 'appbridge.icns');

    const runtimeSource = path.join(projectRoot, 'runtime');
    const thirdPartySource = path.join(projectRoot, 'third-party');
    const runtimeDestination = path.join(resources, 'runtime');
    const thirdPartyDestination = path.join(resources, 'third-party');
    // Remove components inherited from a previous base bundle before assembling
    // exactly the resources provided by this project.
    fs.rmSync(runtimeDestination, { recursive: true, force: true });
    fs.rmSync(thirdPartyDestination, { recursive: true, force: true });
    const runtimeIncluded = fs.existsSync(runtimeSource) && fs.readdirSync(runtimeSource, { withFileTypes: true }).some((entry) => entry.isDirectory());
    if (runtimeIncluded) copyDirectory(runtimeSource, runtimeDestination);
    const thirdPartyIncluded = fs.existsSync(thirdPartySource) && fs.statSync(thirdPartySource).isDirectory();
    if (thirdPartyIncluded) copyDirectory(thirdPartySource, thirdPartyDestination);
    assertContainedSymlinks(stagedApp);
    const displayHelperSource = path.join(projectRoot, 'native', 'appbridge-display.m');
    const displayHelperOutput = path.join(runtimeDestination, 'display-helper.dylib');
    const displayHelperIncluded = runtimeIncluded && fs.existsSync(displayHelperSource);
    if (displayHelperIncluded) {
      run('/usr/bin/clang', [
        '-arch', 'x86_64', '-mmacosx-version-min=14.0', '-dynamiclib', '-fobjc-arc',
        '-framework', 'AppKit', '-Wall', '-Wno-unused-parameter',
        '-o', displayHelperOutput, displayHelperSource,
      ]);
    }
    const processHelperSource = path.join(projectRoot, 'native', 'appbridge-processes.c');
    const processHelperOutput = path.join(runtimeDestination, 'appbridge-processes');
    if (runtimeIncluded && fs.existsSync(processHelperSource)) {
      run('/usr/bin/clang', ['-arch', process.arch, '-mmacosx-version-min=14.0', '-O2', '-Wall', '-Wextra',
        '-o', processHelperOutput, processHelperSource]);
    }

    const runtimeManifestFile = path.join(projectRoot, 'runtime-manifest.json');
    const runtimeManifest = fs.existsSync(runtimeManifestFile) ? JSON.parse(fs.readFileSync(runtimeManifestFile, 'utf8')) : null;
    if (runtimeManifest !== null && (typeof runtimeManifest !== 'object' || Array.isArray(runtimeManifest))) {
      throw new Error('runtime-manifest.json 必须包含 JSON 对象。');
    }

    // Only the newly copied build is prepared and signed; the input stays intact.
    if (!skipSign) {
      run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagedApp]);
      // iCloud can mark an app package with FinderInfo. Remove only the two
      // metadata fields rejected by codesign, preserving File Provider metadata.
      run('/usr/bin/xattr', ['-dr', 'com.apple.FinderInfo', stagedApp]);
      run('/usr/bin/xattr', ['-dr', 'com.apple.ResourceFork', stagedApp]);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', stagedApp]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    }
    const buildInfo = {
      application: metadata.productName,
      version: metadata.version,
      target: `darwin-${process.arch}`,
      builtAt: new Date().toISOString(),
      baseApplication: baseApp,
      appleDeveloperSigned: false,
      notarized: false,
      localAdHocSignatureVerified: !skipSign,
      signatureVerificationScope: 'Local staging bundle before transfer to iCloud; archive contents preserve the verified bundle',
      applicationFiles: fileHashes(applicationDirectory),
      bundledResources: {
        appIcon: { source: 'assets/appbridge.icns', file: 'appbridge.icns', sha256: digest(appIconOutput) },
        runtime: {
          included: runtimeIncluded,
          provenance: runtimeManifest,
          manifestSha256: runtimeManifest ? digest(runtimeManifestFile) : null,
        },
        processChecker: runtimeIncluded && fs.existsSync(processHelperOutput) ? { file: 'runtime/appbridge-processes', sourceSha256: digest(processHelperSource), sha256: digest(processHelperOutput) } : null,
        displayHelper: displayHelperIncluded ? {
          source: 'native/appbridge-display.m', sourceSha256: digest(displayHelperSource),
          file: 'runtime/display-helper.dylib', sha256: digest(displayHelperOutput),
          architecture: 'x86_64', minimumMacOS: '14.0',
        } : null,
        thirdPartyFiles: thirdPartyIncluded ? fileHashes(thirdPartyDestination) : [],
      },
    };
    const stagedBuildInfo = path.join(stagingDirectory, '构建信息.json');
    fs.writeFileSync(stagedBuildInfo, `${JSON.stringify(buildInfo, null, 2)}\n`, { mode: 0o644 });
    const installerSource = path.join(projectRoot, 'scripts', 'install.command');
    const stagedInstaller = path.join(stagingDirectory, '安装并打开.command');
    if (fs.existsSync(installerSource)) {
      fs.copyFileSync(installerSource, stagedInstaller);
      fs.chmodSync(stagedInstaller, 0o755);
    }
    const stagedArchive = path.join(stagingDirectory, `AppBridge-Mac-arm64-${metadata.version}.zip`);
    run('/usr/bin/ditto', ['-c', '-k', '--noextattr', '--norsrc', '--keepParent', stagedApp, stagedArchive]);
    buildInfo.archive = { file: path.basename(stagedArchive), sha256: digest(stagedArchive), sizeBytes: fs.statSync(stagedArchive).size };
    const cloudLauncherSource = path.join(projectRoot, 'scripts', 'launch-cloud.command');
    const cloudLauncher = fs.readFileSync(cloudLauncherSource, 'utf8').replaceAll('__VERSION__', metadata.version).replaceAll('__SHA256__', buildInfo.archive.sha256);
    fs.writeFileSync(path.join(buildDirectory, '打开 AppBridge.command'), cloudLauncher, { mode: 0o755 });
    fs.writeFileSync(stagedBuildInfo, `${JSON.stringify(buildInfo, null, 2)}\n`, { mode: 0o644 });

    const previousApp = path.join(stagingDirectory, 'previous-AppBridge.app');
    const hadPrevious = fs.existsSync(outputApp);
    if (hadPrevious) fs.renameSync(outputApp, previousApp);
    try {
      fs.renameSync(stagedApp, outputApp);
    } catch (error) {
      if (hadPrevious) {
        try { fs.renameSync(previousApp, outputApp); }
        catch (restoreError) {
          preserveStaging = true;
          throw new Error(`${error.message}\n旧构建保留在：${previousApp}\n恢复失败：${restoreError.message}`);
        }
      }
      throw error;
    }
    fs.renameSync(stagedBuildInfo, path.join(buildDirectory, '构建信息.json'));
    fs.renameSync(stagedArchive, path.join(buildDirectory, path.basename(stagedArchive)));
    if (fs.existsSync(stagedInstaller)) fs.renameSync(stagedInstaller, path.join(buildDirectory, '安装并打开.command'));
    console.log(`构建完成：${outputApp}`);
    console.log(skipSign ? '已跳过本机签名；此构建未通过签名验证。' : '本机临时签名与完整性验证已通过。');
  } finally {
    if (!preserveStaging) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) { console.error(error.stack || error.message || String(error)); process.exitCode = 1; }

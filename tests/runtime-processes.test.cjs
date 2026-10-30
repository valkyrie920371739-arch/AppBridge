'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { scanRuntimeProcesses } = require('../src/runtime-processes.cjs');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-processes-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefixPath = path.join(directory, 'prefix with spaces');
  const helperPath = path.join(directory, 'helper $literal');
  fs.mkdirSync(prefixPath);
  fs.writeFileSync(helperPath, 'fixture executable', { mode: 0o700 });
  const calls = [];
  const execRunner = async (...args) => { calls.push(args); return { exitCode: 0, stdout: '[]', stderr: '' }; };
  return { directory, calls, options: { helperPath, prefixPath, execRunner, platform: 'darwin' } };
}
const successful = (value) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });

test('prefix inventory passes a literal canonical prefix to the fixed helper with bounded execution', async (t) => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'prefix alias'); fs.symlinkSync(f.options.prefixPath, alias);
  assert.deepEqual(await scanRuntimeProcesses({ ...f.options, prefixPath: alias }), []);
  assert.deepEqual(f.calls, [[f.options.helperPath, ['--prefix', f.options.prefixPath], { timeout: 10000, maxBuffer: 1048576, windowsHide: true }]]);
});

test('validated application, service, server and unknown entries are retained without unrelated fields', async (t) => {
  const f = fixture(t);
  const values = [{ pid: 42, name: 'ReSister.exe', kind: 'application' }, { pid: 43, name: 'explorer.exe', kind: 'service' },
    { pid: 44, name: 'wineserver', kind: 'server' }, { pid: 45, name: 'unreadable Wine process', kind: 'unknown' }];
  const actual = await scanRuntimeProcesses({ ...f.options, execRunner: async () => successful(values) });
  assert.deepEqual(actual, values);
  assert.equal(actual.some((entry) => entry.kind === 'unknown'), true, 'unreadable Wine must not become an empty safe result');
  assert.notEqual(actual[0], values[0]);
});

test('transport errors and untrusted output fail closed instead of becoming an empty inventory', async (t) => {
  const f = fixture(t);
  for (const result of [null, { stdout: '[]' }, { exitCode: 1, stdout: '[]' }, { ...successful([]), timedOut: true },
    { ...successful([]), signal: 'SIGTERM' }, { ...successful([]), error: 'failed' },
    { ...successful([]), outputTruncated: true }, { ...successful([]), stderr: 'unexpected output' },
    { ...successful([]), stdout: 'x'.repeat(1048577) }, { ...successful([]), stdout: 'not JSON' }]) {
    await assert.rejects(scanRuntimeProcesses({ ...f.options, execRunner: async () => result }));
  }
  await assert.rejects(scanRuntimeProcesses({ ...f.options, execRunner: async () => { throw new Error('runner failed'); } }), /runner failed/);
});

test('malformed or leaking records, duplicate PIDs and unsupported classifications are rejected', async (t) => {
  const f = fixture(t);
  const app = { pid: 123, name: 'Example.exe', kind: 'application' };
  for (const value of [{}, null, true, [null], [{ ...app, pid: 0 }], [{ ...app, pid: 1.5 }],
    [{ ...app, pid: 0x80000000 }], [app, app], [{ ...app, name: '' }], [{ ...app, name: 'x'.repeat(256) }],
    [{ ...app, name: '../Example.exe' }], [{ ...app, name: 'C:\\Example.exe' }], [{ ...app, name: 'x\n.exe' }],
    [{ ...app, kind: 'safe' }], [{ ...app, environment: 'must never be accepted' }], new Array(513).fill(app)]) {
    await assert.rejects(scanRuntimeProcesses({ ...f.options, execRunner: async () => successful(value) }));
  }
});

test('only the exact allowlisted service basenames may be reported as disposable services', async (t) => {
  const f = fixture(t);
  for (const value of [{ pid: 123, name: 'Game.exe', kind: 'service' }, { pid: 123, name: 'wine', kind: 'server' },
    { pid: 123, name: 'UnityCrashHandler64.exe', kind: 'service' }]) {
    await assert.rejects(scanRuntimeProcesses({ ...f.options, execRunner: async () => successful([value]) }), /服务分类无效/);
  }
  assert.equal((await scanRuntimeProcesses({ ...f.options, execRunner: async () => successful([{ pid: 123, name: 'RPCSS.EXE', kind: 'service' }]) }))[0].kind, 'service');
});

test('missing, non-executable, redirected helper and invalid prefixes cannot execute a scan', async (t) => {
  const f = fixture(t);
  const helperLink = path.join(f.directory, 'helper link'); fs.symlinkSync(f.options.helperPath, helperLink);
  for (const override of [{ platform: 'linux' }, { helperPath: 'relative' }, { helperPath: helperLink },
    { prefixPath: '/' }, { prefixPath: 'relative' }, { prefixPath: f.options.helperPath },
    { prefixPath: path.join(f.directory, 'missing') }]) {
    await assert.rejects(scanRuntimeProcesses({ ...f.options, ...override }));
  }
  fs.chmodSync(f.options.helperPath, 0o600);
  await assert.rejects(scanRuntimeProcesses(f.options));
  assert.equal(f.calls.length, 0);
});

function compile(source, destination, extra = []) {
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-mmacosx-version-min=14.0', '-Wall', '-Wextra', ...extra, source, '-o', destination], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('native argument parser handles Wine argv padding, literal prefix matching and malformed buffers', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, (t) => {
  const f = fixture(t); const source = path.join(f.directory, 'parser.c'), executable = path.join(f.directory, 'parser');
  const native = path.resolve(__dirname, '../native/appbridge-processes.c');
  fs.writeFileSync(source, `
#define APPBRIDGE_PROCESSES_NO_MAIN
#include ${JSON.stringify(native)}
#include <assert.h>
int main(int argc, char **argv) {
 assert(argc==2); const char *prefix=argv[1]; char buffer[8192]={0}; int count=3; memcpy(buffer,&count,sizeof(count));
 char *p=buffer+sizeof(count); const char *exec="/runtime/wine"; memcpy(p,exec,strlen(exec)+1); p+=strlen(exec)+4;
 const char *program="Z:\\\\Games\\\\Example.exe"; memcpy(p,program,strlen(program)+1);p+=strlen(program)+1;
 memcpy(p,"argument",9);p+=9;*p++=0;p+=5; // Wine retains an empty argv plus padding.
 memcpy(p,"WINEPREFIX=",11);p+=11;memcpy(p,prefix,strlen(prefix)+1);p+=strlen(prefix)+1;
 memcpy(p,"SECRET=never-output",20);p+=20;*p++=0;
 struct arguments parsed;
 assert(parse_arguments(buffer,(size_t)(p-buffer),prefix,&parsed)); assert(parsed.prefix_matches);assert(!strcmp(parsed.name,"Example.exe"));
 assert(!parse_arguments(buffer,3,prefix,&parsed));
 int impossible=65537;memcpy(buffer,&impossible,sizeof(impossible));assert(!parse_arguments(buffer,(size_t)(p-buffer),prefix,&parsed));memcpy(buffer,&count,sizeof(count));
 // A duplicate WINEPREFIX makes the result indeterminate rather than safe.
 --p;memcpy(p,"WINEPREFIX=",11);p+=11;memcpy(p,prefix,strlen(prefix)+1);p+=strlen(prefix)+1;*p++=0;
 assert(!parse_arguments(buffer,(size_t)(p-buffer),prefix,&parsed));
 assert(!strcmp(classify("UnityCrashHandler64.exe","wine"),"application"));
 assert(!strcmp(classify("explorer.exe","wine"),"service"));
 assert(!strcmp(classify("wineserver","wineserver"),"server"));
 return 0;
}`);
  compile(source, executable, ['-Wno-unused-function']);
  execFileSync(executable, [f.options.prefixPath], { stdio: ['ignore', 'pipe', 'pipe'] });
});

test('native inventory finds only same-prefix executable and service fixtures without emitting other environment data', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 30000 }, async (t) => {
  const f = fixture(t), helper = path.join(f.directory, 'appbridge-processes'), source = path.join(f.directory, 'fixture.c');
  compile(path.resolve(__dirname, '../native/appbridge-processes.c'), helper, ['-Werror', '-O2']);
  fs.writeFileSync(source, '#include <stdio.h>\n#include <unistd.h>\nint main(void){puts("ready");fflush(stdout);for(;;)pause();}\n');
  const app = path.join(f.directory, 'Fixture.exe'), service = path.join(f.directory, 'explorer.exe');
  compile(source, app); fs.copyFileSync(app, service);
  const children = [app, service].map((program) => spawn(program, [], { env: { WINEPREFIX: f.options.prefixPath, APPBRIDGE_PRIVATE_TEST_VALUE: 'secret-is-never-emitted' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter((child) => child.exitCode === null).map((child) => once(child, 'close'))); });
  await Promise.all(children.map((child) => once(child.stdout, 'data')));
  const result = await scanRuntimeProcesses({ helperPath: helper, prefixPath: f.options.prefixPath });
  assert.deepEqual(result.filter((entry) => children.some((child) => child.pid === entry.pid)).sort((a,b) => a.pid-b.pid), [
    { pid: children[0].pid, name: 'Fixture.exe', kind: 'application' }, { pid: children[1].pid, name: 'explorer.exe', kind: 'service' },
  ].sort((a,b) => a.pid-b.pid));
  assert.equal(JSON.stringify(result).includes('secret-is-never-emitted'), false);
  const otherPrefix = path.join(f.directory, 'other prefix'); fs.mkdirSync(otherPrefix);
  const other = await scanRuntimeProcesses({ helperPath: helper, prefixPath: otherPrefix });
  assert.equal(other.some((entry) => children.some((child) => child.pid === entry.pid)), false);
});

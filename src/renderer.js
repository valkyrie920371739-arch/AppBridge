'use strict';
const $ = (id) => document.getElementById(id);
let state = { games: [], platform: '', arch: '', version: '', wineVersion: null, runtimeActivity: null, runtimeCheck: null, recoveryMessages: [], workspace: null };
let filter = 'all';
let busy = false;
let menuId = null;
let toastTimer;
const pending = new Set();
const shownRecoveryMessages = new Set();
const workspaceOpening = new Set();
let runtimePending = null;
let displayGameId = null;
let displaySaving = false;
const displayPresets = { '16:9': [1280, 720], '16:10': [1440, 900], '4:3': [1024, 768] };
const labels = { all: '全部应用', windows: 'Windows 应用', native: '原生应用' };
let view = readPreference('view') === 'list' ? 'list' : 'grid';
let selectedAppId = readPreference('selectedApp');
const savedTheme = readPreference('theme');
document.documentElement.dataset.theme = savedTheme === 'dark' || (!savedTheme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';

function readPreference(key) { try { return localStorage.getItem('appbridge:' + key); } catch { return null; } }
function savePreference(key, value) { try { localStorage.setItem('appbridge:' + key, value); } catch {} }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function icon(name, className = '') { const node = element('span', className); node.innerHTML = window.AppIcons[name] || ''; node.setAttribute('aria-hidden', 'true'); return node; }
function decorateIcons(root = document) { for (const node of root.querySelectorAll('[data-icon]')) { node.innerHTML = window.AppIcons[node.dataset.icon] || ''; node.setAttribute('aria-hidden', 'true'); } }
function button(text, className, iconName, action) { const node = element('button', className); node.type = 'button'; if (iconName) node.append(icon(iconName)); node.append(element('span', '', text)); node.addEventListener('click', action); return node; }
async function request(promise) { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
function message(text, error = false) {
  clearTimeout(toastTimer);
  const node = $('status');
  const activeDialog = document.querySelector('.panel-dialog[open]');
  (activeDialog || document.querySelector('.workspace')).append(node);
  node.replaceChildren(icon(error ? 'CircleHelp' : 'Check'), element('span', '', text));
  node.className = 'feedback' + (error ? ' error' : '') + (activeDialog ? ' dialog-feedback' : '');
  node.hidden = false;
  const close = button('', 'icon-button', 'X', () => { node.hidden = true; }); close.setAttribute('aria-label', '关闭提示'); node.append(close);
  if (activeDialog) node.scrollIntoView({ block: 'nearest' });
  if (!error) toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}
function showDialog(id) { closeMenu(); const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function closeMenu() { menuId = null; document.querySelectorAll('.menu').forEach((menu) => menu.remove()); document.querySelectorAll('[aria-haspopup="menu"]').forEach((node) => node.setAttribute('aria-expanded', 'false')); }
function openSettings() { updateEnvironment(); showDialog('settings-dialog'); }
function updateWorkspace() {
  const folders = state.workspace || {};
  const available = typeof folders.root === 'string' && folders.root.length > 0;
  $('workspace-root-path').textContent = available ? folders.root : '正在读取工作区…';
  $('workspace-unavailable').hidden = available;
  for (const node of document.querySelectorAll('[data-workspace-section]')) {
    const section = node.dataset.workspaceSection;
    const opening = workspaceOpening.has(section);
    node.disabled = opening || typeof folders[section] !== 'string' || !folders[section];
    node.setAttribute('aria-busy', String(opening));
    node.replaceChildren(icon(opening ? 'LoaderCircle' : 'FolderOpen', opening ? 'loading-icon' : ''), element('span', '', opening ? '正在打开…' : section === 'root' ? '打开工作区' : '打开'));
  }
}
function openWorkspace() {
  if ($('settings-dialog').open) $('settings-dialog').close();
  updateWorkspace(); showDialog('workspace-dialog');
}
async function openWorkspaceFolder(section) {
  const allowed = ['root', 'runtime', 'apps', 'cache', 'logs', 'exports'];
  if (!allowed.includes(section) || workspaceOpening.has(section) || !state.workspace?.[section]) return;
  workspaceOpening.add(section); updateWorkspace();
  try { await request(window.player.workspace(section)); }
  catch (error) { message(error.message, true); }
  finally { workspaceOpening.delete(section); updateWorkspace(); }
}

async function importApp() {
  if (busy) return; busy = true; updateBusy(); closeMenu();
  try {
    const result = await request(window.player.importGame());
    if (result) { state = await request(window.player.state()); render(); message(result.alreadyImported ? '应用已在资料库中。' : '已添加到资料库。'); }
  } catch (error) { message(error.message, true); }
  finally { busy = false; updateBusy(); }
}
function updateBusy() {
  document.querySelectorAll('[data-action="import"]').forEach((node) => { node.disabled = busy; });
  $('import').replaceChildren(icon(busy ? 'LoaderCircle' : 'Plus', busy ? 'loading-icon' : ''), element('span', '', busy ? '正在添加…' : '添加应用'));
}
async function configureRuntime(action = 'choose') {
  if (runtimePending || state.runtimeActivity || state.games.some((game) => game.launching)) return;
  runtimePending = action; updateEnvironment(); renderLibrary();
  try {
    const result = await request(action === 'detect' ? window.player.detectRuntime() : action === 'test' ? window.player.testRuntime() : window.player.runtime());
    state = await request(window.player.state()); render();
    if (result) message(action === 'test' ? 'Windows 基础启动自检通过，可尝试打开应用。' : '已检测到运行环境，可继续测试 Windows 启动。');
  }
  catch (error) { message(error.message, true); }
  finally { runtimePending = null; updateEnvironment(); renderLibrary(); }
}
function updateEnvironment() {
  const configured = Boolean(state.wineVersion);
  const check = state.runtimeCheck;
  const activity = state.runtimeActivity || (runtimePending === 'test' ? '正在测试 Windows 启动，首次初始化可能需要约一分钟…' : runtimePending === 'detect' ? '正在检测可用运行环境…' : runtimePending ? '正在选择与检测运行环境…' : '');
  const blocked = Boolean(activity) || state.games.some((game) => game.launching);
  const failed = Boolean(check && !check.ok);
  $('environment-banner').hidden = configured || !state.games.some((game) => game.kind === 'windows');
  $('sidebar-runtime-dot').className = 'status-dot ' + (configured && !failed ? 'green' : 'amber');
  $('sidebar-runtime-dot').setAttribute('aria-label', activity ? '正在检测运行环境' : failed ? '上次自检未通过' : configured ? '已检测运行环境' : '尚未检测');
  $('wine-status').textContent = configured ? state.wineVersion + '。运行组件已检测，可测试 Windows 基础启动。' : '完整构建已附带免费运行组件。点击自动检测，也可手动选择已有的 Wine。';
  $('runtime-badge').textContent = activity ? '检测中' : failed ? '自检未通过' : check?.ok ? '基础自检通过' : configured ? '已检测' : '待检测';
  $('runtime-badge').className = 'state-pill ' + (activity ? 'pending' : failed ? 'failed' : configured ? 'running' : 'needs');
  const sources = { bundled: '应用内置', user: '个人应用文件夹', system: '系统应用文件夹', homebrew: '本机 Homebrew' };
  $('runtime-metadata').hidden = !state.runtimePath;
  $('runtime-source').textContent = sources[state.runtimeSource] || state.runtimeSource || '已选择';
  $('runtime-path').textContent = state.runtimePath || '';
  $('runtime-progress').hidden = !activity;
  if ($('runtime-progress-text').textContent !== activity) $('runtime-progress-text').textContent = activity;
  $('runtime-check').hidden = !check;
  $('runtime-check').className = 'runtime-check' + (failed ? ' failed' : ' passed');
  $('runtime-check-title').textContent = failed ? '上次 Windows 基础启动自检未通过' : '上次 Windows 基础启动自检通过';
  $('runtime-check-message').textContent = check ? (failed ? check.error || '未得到预期结果，请导出诊断日志。' : 'Windows 命令已执行并返回预期结果，具体应用仍需单独检查。') : '';
  $('runtime-check-time').textContent = check?.checkedAt ? formatTime(check.checkedAt) : '';
  for (const id of ['detect-runtime', 'choose-runtime', 'test-runtime']) $(id).disabled = blocked || state.platform !== 'darwin';
  $('choose-runtime').replaceChildren(icon('FolderOpen'), element('span', '', configured ? '手动更换' : '手动选择'));
  $('test-runtime').replaceChildren(icon(runtimePending === 'test' ? 'LoaderCircle' : 'Play', runtimePending === 'test' ? 'loading-icon' : ''), element('span', '', runtimePending === 'test' ? '正在测试 Windows 启动…' : '测试 Windows 启动'));
  $('runtime-card').setAttribute('aria-busy', String(Boolean(activity)));
  $('runtime').textContent = (state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : state.platform) + ' · ' + state.arch;
}
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function statusFor(game) {
  if (game.relocating) return { text: '正在整理数据', className: 'pending' };
  if (pending.has(game.id) || game.launching) return { text: '正在启动', className: 'pending' };
  if (game.running) return { text: '运行中', className: 'running' };
  if (game.kind === 'windows' && (state.runtimeActivity || runtimePending)) return { text: '正在准备环境', className: 'pending' };
  if (game.kind !== 'windows') return { text: '原生加载', className: 'native' };
  if (game.lastExit && !game.lastExit.ok) return { text: '上次启动异常', className: 'failed' };
  return state.wineVersion ? { text: '可启动', className: 'ready' } : { text: '需要运行环境', className: 'needs' };
}
function typeFor(game) { return game.kind === 'windows' ? (game.compatibilityInfo?.engineName || game.engineProfile?.name || 'Windows 程序') + ' · ' + game.architecture : 'TyranoScript · 原生加载'; }
function displayName(game) { return String(game.title || '未命名应用').replace(/\.exe$/i, ''); }
function appIcon(game) {
  const node = element('span', 'app-icon'); node.setAttribute('aria-hidden', 'true');
  if (typeof game.iconData === 'string' && game.iconData.startsWith('data:image/png;base64,')) {
    node.classList.add('has-image'); const image = element('img'); image.src = game.iconData; image.alt = ''; image.draggable = false; node.append(image);
    image.addEventListener('error', () => { node.replaceWith(fallbackIcon(game)); }, { once: true });
    return node;
  }
  return fallbackIcon(game);
}
function fallbackIcon(game) {
  const title = displayName(game); const capitals = title.match(/[A-Z]/g);
  const initials = capitals && capitals.length > 1 ? capitals.slice(0, 2).join('') : [...title].slice(0, 2).join('').toUpperCase();
  const palettes = [['#dfe6f4', '#455e8b'], ['#f4dfe5', '#8b4e65'], ['#dfebe2', '#4a7057'], ['#e9e2f5', '#6b548c'], ['#f2e7d5', '#856d43']];
  const hash = [...title].reduce((value, ch) => (value * 31 + ch.codePointAt(0)) >>> 0, 0);
  const colors = palettes[hash % palettes.length]; const node = element('span', 'app-icon initial-icon', initials);
  node.style.setProperty('--icon-fill', colors[0]); node.style.setProperty('--icon-ink', colors[1]); node.setAttribute('aria-hidden', 'true'); return node;
}
function pill(game) { const status = statusFor(game); const node = element('span', 'state-pill ' + status.className); node.append(element('span', 'status-dot'), element('span', '', status.text)); return node; }
function playedLabel(game) {
  if (!game.lastPlayedAt) return '尚未启动';
  const date = new Date(game.lastPlayedAt); return Number.isNaN(date.getTime()) ? '已发起启动' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' 打开';
}
async function launch(game) {
  if (pending.has(game.id) || game.launching || (game.kind === 'windows' && (state.runtimeActivity || runtimePending))) return;
  if (game.kind === 'windows' && !state.wineVersion) { openSettings(); return; }
  pending.add(game.id); renderLibrary();
  try { await request(window.player.launch(game.id)); message('正在打开 ' + displayName(game) + '…'); }
  catch (error) { message(error.message, true); }
  finally { pending.delete(game.id); renderLibrary(); }
}
function showData(game) { window.AppDataPanel.open(game, { request, getState: () => state, onState: (value) => { state = value; render(); }, message, showDialog }); }
function showCompatibility(game) { window.AppCompatibilityPanel.open(game, { request, getState: () => state, onState: (value) => { state = value; render(); }, isPending: (id) => pending.has(id), message, showDialog }); }
function displayOptions(game) {
  const value = game.display || {};
  return {
    mode: ['app', 'windowed', 'fullscreen'].includes(value.mode) ? value.mode : 'app',
    width: Number.isInteger(value.width) && value.width >= 640 && value.width <= 7680 ? value.width : 1280,
    height: Number.isInteger(value.height) && value.height >= 360 && value.height <= 4320 ? value.height : 720,
    hideDock: value.hideDock !== false,
  };
}
function updateDisplayPreset() {
  const width = $('display-width').valueAsNumber;
  const height = $('display-height').valueAsNumber;
  $('display-preset').value = Object.keys(displayPresets).find((key) => displayPresets[key][0] === width && displayPresets[key][1] === height) || 'custom';
}
function updateDisplayBusy() {
  const game = state.games.find((item) => item.id === displayGameId);
  const active = Boolean(game && (game.running || game.launching || game.relocating || pending.has(game.id)));
  $('display-fields').disabled = displaySaving || active || !game;
  $('display-save').disabled = displaySaving || active || !game;
  $('display-locked').hidden = !active;
  $('display-save').replaceChildren(icon(displaySaving ? 'LoaderCircle' : 'Check', displaySaving ? 'loading-icon' : ''), element('span', '', displaySaving ? '正在保存…' : '保存设置'));
  $('display-form').setAttribute('aria-busy', String(displaySaving));
}
function showDisplaySettings(game) {
  game = state.games.find((item) => item.id === game.id) || game;
  if (game.kind !== 'windows') return;
  if (displaySaving) { message('正在保存显示设置，请稍候。'); return; }
  if ($('details-dialog').open) $('details-dialog').close();
  displayGameId = game.id;
  const options = displayOptions(game);
  $('display-app-name').textContent = displayName(game);
  $('display-mode').value = options.mode;
  $('display-width').value = options.width;
  $('display-height').value = options.height;
  $('display-hide-dock').checked = options.hideDock;
  $('display-support').textContent = '设置用于下次启动。进入应用后，仍可使用它自身支持的分辨率与全屏选项。';
  updateDisplayPreset(); updateDisplayBusy(); showDialog('display-dialog');
}
async function saveDisplaySettings(event) {
  event.preventDefault();
  const game = state.games.find((item) => item.id === displayGameId);
  if (!game || displaySaving) return;
  if (game.running || game.launching || game.relocating || pending.has(game.id)) { message('请先关闭游戏并等待启动结束，再修改显示设置。', true); return; }
  if (!$('display-form').reportValidity()) return;
  const options = { mode: $('display-mode').value, width: $('display-width').valueAsNumber, height: $('display-height').valueAsNumber, hideDock: $('display-hide-dock').checked };
  if (!Number.isInteger(options.width) || options.width < 640 || options.width > 7680 || !Number.isInteger(options.height) || options.height < 360 || options.height > 4320) {
    message('请输入有效的整数尺寸：宽度 640–7680，高度 360–4320。', true); return;
  }
  displaySaving = true; updateDisplayBusy();
  try {
    game.display = await request(window.player.display(game.id, options));
    state = await request(window.player.state()); render();
    $('display-dialog').close();
    message('显示设置已保存，下次启动时应用；进入游戏后仍可调整。');
  } catch (error) { message(error.message, true); }
  finally { displaySaving = false; updateDisplayBusy(); }
}
async function changeEntry(game) { try { const changed = await request(window.player.entry(game.id)); if (changed) { state = await request(window.player.state()); render(); message('已更新启动程序。'); } } catch (error) { message(error.message, true); } }
async function remove(game) {
  try { await request(window.player.remove(game.id)); state = await request(window.player.state()); render(); if ($('details-dialog').open) $('details-dialog').close(); message('已移出资料库，文件与数据仍保留。'); }
  catch (error) { message(error.message, true); }
}
function toggleMenu(game, trigger, card) {
  const wasOpen = menuId === game.id; closeMenu(); if (wasOpen) return;
  menuId = game.id; trigger.setAttribute('aria-expanded', 'true'); const menu = element('div', 'menu'); menu.setAttribute('role', 'menu');
  const item = (text, name, action, danger = false) => { const node = button(text, 'menu-item' + (danger ? ' danger' : ''), name, () => { closeMenu(); action(); }); node.setAttribute('role', 'menuitem'); menu.append(node); };
  item('应用信息', 'CircleHelp', () => showDetails(game));
  if (game.kind === 'windows') item('显示设置', 'AppWindow', () => showDisplaySettings(game));
  if (game.kind === 'windows') item('兼容设置', 'Settings', () => showCompatibility(game));
  item(game.kind === 'windows' ? '数据与运行日志' : '打开存档目录', 'FolderOpen', () => showData(game));
  if (game.kind === 'windows') item('更改启动程序', 'FileCode', () => changeEntry(game));
  menu.append(element('div', 'menu-separator')); item('移出资料库', 'Trash2', () => remove(game), true);
  document.body.append(menu);
  const anchor = trigger.getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8));
  const below = anchor.bottom + 6;
  const top = below + bounds.height <= innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.querySelector('button').focus({ preventScroll: true });
  menu.addEventListener('keydown', (event) => { const items = [...menu.querySelectorAll('button')]; const index = items.indexOf(document.activeElement); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); trigger.focus(); } });
}
function selectApp(id, focus = true) {
  selectedAppId = id; savePreference('selectedApp', id); closeMenu();
  for (const card of document.querySelectorAll('.app-card')) {
    const selected = card.dataset.appId === id; card.classList.toggle('selected', selected);
    card.querySelector('.card-main').setAttribute('aria-pressed', String(selected));
  }
  renderInspector(filteredApps().find((game) => game.id === id));
  if (focus) [...document.querySelectorAll('.app-card')].find((card) => card.dataset.appId === id)?.querySelector('.card-main')?.focus({ preventScroll: true });
}
function renderCard(game) {
  const selected = selectedAppId === game.id;
  const card = element('article', 'app-card' + (selected ? ' selected' : '')); card.dataset.appId = game.id;
  const main = button('', 'card-main', null, () => selectApp(game.id)); main.setAttribute('aria-label', '选择 ' + displayName(game)); main.setAttribute('aria-pressed', String(selected));
  main.replaceChildren(appIcon(game));
  const title = element('div', 'card-title-group'); title.append(element('h3', '', displayName(game)), element('p', 'app-type', game.kind === 'windows' ? 'Windows 应用' : '原生应用')); main.append(title);
  main.addEventListener('dblclick', () => launch(game));
  main.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const apps = filteredApps(); const index = apps.findIndex((item) => item.id === game.id);
    const columns = view === 'list' ? 1 : Math.max(1, getComputedStyle($('games')).gridTemplateColumns.split(' ').length);
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : -columns;
    selectApp(apps[Math.max(0, Math.min(apps.length - 1, index + offset))].id);
  });
  const more = button('', 'icon-button card-more', 'Ellipsis', () => toggleMenu(game, more, card));
  more.setAttribute('aria-label', displayName(game) + ' 的更多操作'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
  card.append(main, more); return card;
}
function renderInspector(game) {
  const root = $('app-inspector'); root.replaceChildren();
  if (!game) {
    const empty = element('div', 'inspector-empty'); empty.append(icon('AppWindow'), element('p', '', state.games.length ? '选择一个应用，查看启动与显示设置。' : '添加应用后，即可在这里启动和管理。')); root.append(empty); return;
  }
  const top = element('div', 'inspector-top'); top.append(element('span', '', '所选应用'));
  const more = button('', 'icon-button', 'Ellipsis', () => toggleMenu(game, more, root)); more.setAttribute('aria-label', '所选应用的更多操作'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); top.append(more);
  const identity = element('div', 'inspector-identity'); identity.append(appIcon(game), element('h2', '', displayName(game)), element('p', 'app-type', game.kind === 'windows' ? 'Windows 应用' : '原生应用'), pill(game));
  const waiting = pending.has(game.id) || game.launching || game.relocating;
  const label = game.relocating ? '正在整理数据…' : waiting ? '正在启动…' : game.kind === 'windows' && (state.runtimeActivity || runtimePending) ? '正在准备环境…' : game.kind === 'windows' && !state.wineVersion ? '准备运行环境' : game.running ? game.kind === 'windows' ? '正在运行' : '回到应用' : '启动应用';
  const play = button(label, 'button primary inspector-launch', waiting ? 'LoaderCircle' : game.kind === 'windows' && !state.wineVersion ? 'Settings' : 'Play', () => launch(game));
  play.disabled = waiting || Boolean(game.kind === 'windows' && (game.running || state.runtimeActivity || runtimePending));
  if (waiting) play.querySelector('span').classList.add('loading-icon');
  const actions = element('div', 'inspector-actions');
  const action = (text, name, callback) => { const node = button(text, 'inspector-action', name, callback); node.append(icon('ChevronRight')); return node; };
  if (game.kind === 'windows') actions.append(action('显示设置', 'AppWindow', () => showDisplaySettings(game)));
  if (game.kind === 'windows') actions.append(action('兼容设置', 'Settings', () => showCompatibility(game)));
  actions.append(action(game.kind === 'windows' ? '数据与存档' : '存档目录', 'FolderOpen', () => showData(game)), action('应用信息', 'CircleHelp', () => showDetails(game)));
  const metadata = element('dl', 'inspector-meta');
  const field = (label, value) => { const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); metadata.append(row); };
  field('最近打开', game.lastPlayedAt ? formatTime(game.lastPlayedAt) : '尚未打开');
  if (game.kind === 'windows') { const display = displayOptions(game); field('启动画面', display.mode === 'app' ? '跟随游戏' : (display.mode === 'fullscreen' ? '全屏' : '窗口') + ' ' + display.width + ' × ' + display.height); field('程序引擎', game.compatibilityInfo?.engineName || game.engineProfile?.name || '尚未识别'); }
  const location = game.exePath || game.archivePath || '';
  field('程序位置', location.includes('com~apple~CloudDocs') ? 'iCloud 云盘' : location.includes('AppBridge') ? 'AppBridge 工作区' : '本机文件夹');
  root.append(top, identity, play, actions, metadata, element('p', 'inspector-note', game.kind === 'windows' ? '应用生成的文件，可在“数据与存档”中查看。' : '游戏进度可在“存档目录”中查看。'));
}
function showDetails(game) {
  game = state.games.find((item) => item.id === game.id) || game;
  const root = $('details-content'); root.replaceChildren();
  const header = element('div', 'dialog-header'); const heading = element('div'); heading.append(element('div', 'eyebrow', '资料库'), element('h2', '', '应用信息')); heading.querySelector('h2').id = 'details-title'; const close = button('', 'icon-button', 'X', () => $('details-dialog').close()); close.setAttribute('aria-label', '关闭应用信息'); header.append(heading, close);
  const identity = element('div', 'detail-identity'); const title = element('div'); title.append(element('h3', '', displayName(game)), element('p', '', typeFor(game))); identity.append(appIcon(game), title);
  const fields = element('dl', 'detail-data'); const field = (label, value, isPath = false) => { if (!value) return; const group = element('div', 'detail-field'); group.append(element('dt', '', label), element('dd', isPath ? 'detail-path' : '', value)); fields.append(group); };
  field('启动方式', game.kind === 'windows' ? 'Wine 兼容运行' : 'TyranoScript 原生加载'); field('程序位置', game.kind === 'windows' ? game.exePath : game.archivePath, true); field('数据目录', game.saveDirectory, true);
  if (game.kind === 'windows') {
    field('识别引擎', game.engineProfile?.id === 'unknown' ? '尚未可靠识别' : game.engineProfile?.name || game.compatibilityInfo?.detectedEngineName || game.engine || '尚未识别');
    if (game.compatibility?.engine && game.compatibility.engine !== 'auto') field('手动适配', game.compatibilityInfo?.engineName || game.compatibility.engine);
    field('图形模式', { auto: '自动', game: '跟随程序', d3d11: 'Direct3D 11', opengl: 'OpenGL 兼容模式' }[game.compatibility?.graphics || 'auto'] || '自动');
    field('本轮引擎适配', '待实际程序验证');
    const display = displayOptions(game);
    field('显示设置', (display.mode === 'app' ? '跟随游戏' : (display.mode === 'fullscreen' ? '全屏' : '窗口') + ' · ' + display.width + ' × ' + display.height) + (display.hideDock ? ' · 游戏运行时隐藏 Dock' : ''));
    if (game.lastExit) {
      const exit = game.lastExit;
      const result = exit.error || (exit.signal ? '进程因 ' + exit.signal + ' 结束' : (exit.ok ? '进程正常退出' : '进程异常退出') + (exit.exitCode !== null && exit.exitCode !== undefined ? '，代码 ' + exit.exitCode : ''));
      field('最近退出结果', [formatTime(exit.at), result].filter(Boolean).join(' · '));
    }
  }
  if (game.kind !== 'windows') field('画面尺寸', game.width + ' × ' + game.height);
  const footer = element('div', 'detail-footer');
  const opening = pending.has(game.id) || game.launching;
  const play = button(opening ? '正在打开…' : game.kind === 'windows' && game.running ? '进程运行中' : game.kind === 'windows' && !state.wineVersion ? '配置环境' : game.running ? '回到应用' : '打开应用', 'button primary', opening ? 'LoaderCircle' : game.kind === 'windows' && !state.wineVersion ? 'Settings' : 'Play', () => { $('details-dialog').close(); launch(game); });
  play.disabled = opening || Boolean(game.kind === 'windows' && (game.running || state.runtimeActivity || runtimePending));
  footer.append(button(game.kind === 'windows' ? '数据与日志' : '存档目录', 'button secondary', 'FolderOpen', () => showData(game)));
  if (game.kind === 'windows') footer.append(button('显示设置', 'button secondary', 'AppWindow', () => showDisplaySettings(game)));
  if (game.kind === 'windows') footer.append(button('兼容设置', 'button secondary', 'Settings', () => showCompatibility(game)));
  footer.append(play);
  root.append(header, identity, pill(game), fields);
  if (game.kind === 'windows') root.append(element('p', 'detail-note', '启动异常时，可先在“兼容设置”中尝试其他图形模式。运行记录和引擎日志集中在“数据与日志”中，也可在“运行环境”中导出诊断日志。'));
  root.append(footer); showDialog('details-dialog');
}
function filteredApps() {
  const query = $('search').value.trim();
  const result = state.games.filter((game) => (filter === 'all' || (filter === 'windows' ? game.kind === 'windows' : game.kind !== 'windows')) && window.AppSearch.matchesApplicationQuery(game, query));
  const sort = $('sort').value;
  return result.sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : (Date.parse(sort === 'played' ? b.lastPlayedAt : b.importedAt) || 0) - (Date.parse(sort === 'played' ? a.lastPlayedAt : a.importedAt) || 0));
}
function renderLibrary() {
  closeMenu(); const root = $('games'); root.replaceChildren(); root.className = 'app-grid' + (view === 'list' ? ' list-view' : '');
  const games = filteredApps(); const query = $('search').value.trim();
  $('count').textContent = games.length + ' 个应用'; $('collection-label').textContent = query ? '搜索结果' : labels[filter];
  const selected = games.find((game) => game.id === selectedAppId) || games[0];
  if (selected) selectedAppId = selected.id;
  renderInspector(selected);
  if (!games.length) {
    const empty = element('div', 'empty-state');
    empty.append(icon(query ? 'Search' : 'AppWindow', 'app-icon'), element('h3', '', query ? '没有找到应用' : state.games.length ? '此分类暂无应用' : '添加你的第一个应用'), element('p', '', query ? '换个名称搜索，或查看全部应用。' : '选择 Windows 程序或安装包，把它收进资料库。'));
    if (query) empty.append(button('清除搜索', 'button secondary', 'X', () => { $('search').value = ''; renderLibrary(); $('search').focus(); }));
    else { const add = button('添加应用', 'button primary', 'Plus', importApp); add.dataset.action = 'import'; add.disabled = busy; empty.append(add); }
    root.append(empty); return;
  }
  for (const game of games) root.append(renderCard(game));
}
function render() {
  $('all-count').textContent = state.games.length; $('windows-count').textContent = state.games.filter((game) => game.kind === 'windows').length; $('native-count').textContent = state.games.filter((game) => game.kind !== 'windows').length;
  $('version').textContent = 'AppBridge · ' + state.version; $('search-shortcut').textContent = state.platform === 'darwin' ? '⌘ F' : 'Ctrl F'; updateEnvironment(); renderLibrary(); updateBusy(); updateWorkspace();
  updateDisplayBusy();
  window.AppDataPanel.refresh();
  window.AppCompatibilityPanel.refresh();
  const recovered = (state.recoveryMessages || []).filter((text) => typeof text === 'string' && !shownRecoveryMessages.has(text));
  if (recovered.length) { recovered.forEach((text) => shownRecoveryMessages.add(text)); message(recovered.join('\n'), true); }
}
function setView(value) { view = value; savePreference('view', value); for (const key of ['grid', 'list']) { const node = $(key + '-view'); node.classList.toggle('selected', key === view); node.setAttribute('aria-pressed', String(key === view)); } renderLibrary(); }
async function exportLog() { try { if (await request(window.player.exportLog())) message('诊断日志已导出。'); } catch (error) { message(error.message, true); } }
decorateIcons();
for (const node of document.querySelectorAll('.nav-item')) node.setAttribute('aria-label', node.dataset.filter ? labels[node.dataset.filter] : node.querySelector('span:not([data-icon])')?.textContent || node.textContent.trim());
$('import').onclick = importApp; $('choose-runtime').onclick = () => configureRuntime('choose');
$('detect-runtime').onclick = () => configureRuntime('detect'); $('test-runtime').onclick = () => configureRuntime('test');
$('display-form').addEventListener('submit', saveDisplaySettings);
$('display-preset').addEventListener('change', () => { const preset = displayPresets[$('display-preset').value]; if (preset) { $('display-width').value = preset[0]; $('display-height').value = preset[1]; } });
$('display-width').addEventListener('input', updateDisplayPreset); $('display-height').addEventListener('input', updateDisplayPreset);
$('open-settings').onclick = openSettings; $('banner-settings').onclick = openSettings;
for (const id of ['open-workspace', 'note-workspace', 'settings-workspace']) $(id).onclick = openWorkspace;
document.querySelectorAll('[data-workspace-section]').forEach((node) => { node.onclick = () => openWorkspaceFolder(node.dataset.workspaceSection); });
for (const id of ['open-help', 'note-help']) $(id).onclick = () => showDialog('help-dialog');
$('settings-help').onclick = () => { $('settings-dialog').close(); showDialog('help-dialog'); };
$('export').onclick = exportLog; $('help-export').onclick = exportLog;
document.querySelectorAll('.close-dialog').forEach((node) => node.addEventListener('click', () => node.closest('dialog').close()));
document.querySelectorAll('.panel-dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { if (dialog.contains($('status'))) { $('status').hidden = true; document.querySelector('.workspace').append($('status')); } });
});
document.querySelectorAll('[data-filter]').forEach((node) => node.onclick = () => { filter = node.dataset.filter; document.querySelectorAll('[data-filter]').forEach((item) => { item.classList.toggle('selected', item === node); if (item === node) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }); $('page-title').textContent = filter === 'all' ? '应用资料库' : labels[filter]; renderLibrary(); });
$('search').addEventListener('input', renderLibrary); $('sort').addEventListener('change', renderLibrary);
$('grid-view').onclick = () => setView('grid'); $('list-view').onclick = () => setView('list');
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; savePreference('theme', theme); $('theme').replaceChildren(icon(theme === 'dark' ? 'Sun' : 'Moon')); };
$('theme').replaceChildren(icon(document.documentElement.dataset.theme === 'dark' ? 'Sun' : 'Moon'));
document.addEventListener('click', (event) => { if (!event.target.closest('.menu') && !event.target.closest('[aria-haspopup="menu"]')) closeMenu(); });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); $('search').focus(); } if (event.key === 'Escape' && menuId) closeMenu(); });
window.addEventListener('resize', closeMenu);
document.querySelector('.library-scroll').addEventListener('scroll', closeMenu, { passive: true });
window.player.onChange((value) => { state = value; render(); });
request(window.player.state()).then((value) => { state = value; setView(view); render(); }).catch((error) => message(error.message, true));

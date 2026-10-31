'use strict';

const path = require('node:path');

const ENGINE_NAMES = Object.freeze({ unity: 'Unity', unreal: 'Unreal Engine', godot: 'Godot', renpy: "Ren'Py", rpgmaker: 'RPG Maker', tyrano: 'TyranoScript / NW.js', unknown: '通用 Windows 程序' });
const GRAPHICS_NAMES = Object.freeze({ auto: '自动适配', game: '跟随程序', d3d11: 'Direct3D 11', opengl: 'OpenGL 兼容模式' });
const ENGINE_IDS = new Set(['auto', ...Object.keys(ENGINE_NAMES)]);
const GRAPHICS_IDS = new Set(Object.keys(GRAPHICS_NAMES));

function canonicalEngine(id) { return ['rpg-maker-mv', 'rpg-maker-mz'].includes(id) ? 'rpgmaker' : Object.hasOwn(ENGINE_NAMES, id) ? id : 'unknown'; }
function preferences(value) {
  return { engine: ENGINE_IDS.has(value?.engine) ? value.engine : 'auto', graphics: GRAPHICS_IDS.has(value?.graphics) ? value.graphics : 'auto' };
}
function resolveEngine(profile, compatibility) {
  const selected = preferences(compatibility).engine;
  const detected = canonicalEngine(profile?.id);
  const id = selected === 'auto' ? detected : selected;
  return { id, name: selected === 'auto' && profile?.name ? profile.name : ENGINE_NAMES[id],
    variant: id === detected ? profile?.variant || null : null,
    engineVersion: id === detected ? profile?.engineVersion || null : null,
    manuallySelected: selected !== 'auto' };
}
function graphicsOptions(engineId) {
  const values = ['auto', 'game'];
  if (['unity', 'unreal'].includes(engineId)) values.push('d3d11');
  if (engineId === 'godot') values.push('opengl');
  return values.map((value) => ({ value, label: GRAPHICS_NAMES[value] }));
}
function compatibilityInfo(game) {
  const engine = resolveEngine(game.engineProfile, game.compatibility);
  const note = ['unity', 'unreal', 'godot'].includes(engine.id)
    ? '自动适配保留程序的图形接口，并按已识别的引擎配置显示与日志参数。具体兼容性待实际程序验证。'
    : '当前仅识别程序类型，沿用通用 Wine 运行方式，不额外覆盖引擎参数。具体兼容性待实际程序验证。';
  return { engineId: engine.id, engineName: engine.name, detectedEngineName: game.engineProfile?.name || ENGINE_NAMES.unknown,
    graphicsOptions: graphicsOptions(engine.id), note: [note, game.compatibilityNotice].filter(Boolean).join(' ') };
}
function validateCompatibility(options, profile) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || !ENGINE_IDS.has(options.engine) || !GRAPHICS_IDS.has(options.graphics)) {
    throw new Error('请选择有效的引擎和图形预设。');
  }
  const value = { engine: options.engine, graphics: options.graphics };
  const engine = resolveEngine(profile, value);
  if (!graphicsOptions(engine.id).some((item) => item.value === value.graphics)) throw new Error('这个引擎不支持所选图形预设，请选择自动适配或跟随程序。');
  if (value.graphics === 'opengl' && !['godot-3', 'godot-4'].includes(engine.variant)) throw new Error('尚未识别 Godot 的主版本，无法选择对应的 OpenGL 参数。请先使用自动适配，或提供完整的程序与 PCK 文件。');
  return value;
}
function winePath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file.includes('\\')) throw new Error('引擎日志必须使用可映射到 Windows 的绝对路径。');
  return `Z:${path.resolve(file).replaceAll('/', '\\')}`;
}
function validateDisplay(display) {
  if (!display || !['app', 'windowed', 'fullscreen'].includes(display.mode) || !Number.isInteger(display.width) || display.width < 640 || display.width > 7680 ||
      !Number.isInteger(display.height) || display.height < 360 || display.height > 4320 || typeof display.hideDock !== 'boolean') throw new Error('引擎显示设置无效。');
}

// These are startup adapters, not claims that a game has passed compatibility
// testing. No registry key, game script or project configuration is rewritten.
function buildEngineLaunchPlan({ profile, compatibility, display, saveDirectory }) {
  // Validate even for generic profiles, which do not currently add a log flag.
  winePath(saveDirectory);
  const settings = validateCompatibility(preferences(compatibility), profile);
  validateDisplay(display);
  const engine = resolveEngine(profile, settings);
  const args = [];
  const logFiles = [];
  const warnings = [...(Array.isArray(profile?.warnings) ? profile.warnings : [])];
  const addLog = (name, flag, combined = false) => {
    const file = path.join(saveDirectory, name);
    const windows = winePath(file);
    logFiles.push({ name, path: file });
    if (combined) args.push(`${flag}=${windows}`); else args.push(flag, windows);
  };
  if (engine.id === 'unity') {
    if (settings.graphics === 'd3d11') args.push('-force-d3d11');
    addLog('unity-player.log', '-logFile');
    if (display.mode !== 'app') {
      args.push('-screen-fullscreen', display.mode === 'fullscreen' ? '1' : '0', '-screen-width', String(display.width), '-screen-height', String(display.height));
      if (display.mode === 'fullscreen') args.push('-window-mode', 'borderless');
    }
  } else if (engine.id === 'unreal') {
    if (settings.graphics === 'd3d11') args.push('-dx11');
    addLog('unreal-player.log', '-ABSLOG', true);
    if (display.mode !== 'app') args.push(display.mode === 'fullscreen' ? '-fullscreen' : '-windowed', `-ResX=${display.width}`, `-ResY=${display.height}`);
    warnings.push('Unreal 的 Shipping 构建可能关闭日志；日志文件缺失不代表程序没有启动。');
  } else if (engine.id === 'godot') {
    if (settings.graphics === 'opengl') {
      args.push(...(engine.variant === 'godot-4' ? ['--rendering-method', 'gl_compatibility', '--rendering-driver', 'opengl3'] : ['--video-driver', 'GLES2']));
      warnings.push('OpenGL 兼容模式需要程序的导出模板包含对应渲染后端，画面效果可能改变。');
    }
    const version = engine.engineVersion;
    if (engine.variant === 'godot-4' && version?.major === 4 && Number.isInteger(version.minor) && version.minor >= 3) addLog('godot-player.log', '--log-file');
    else warnings.push('此 Godot 版本未确认支持自定义日志路径；请同时查看 runtime.log 和运行目录内的 user:// 数据。');
    if (display.mode !== 'app') args.push('--resolution', `${display.width}x${display.height}`, display.mode === 'fullscreen' ? '--fullscreen' : '--windowed');
  } else warnings.push('此引擎目前使用通用 Wine 启动，尚未加入专属启动参数。');
  if (settings.graphics === 'd3d11') warnings.push('Direct3D 11 需要程序本身包含该后端；不能替代 Direct3D 12 专用功能。');
  return { version: 1, engine, compatibility: settings, arguments: args, logFiles, warnings,
    displayHelperMode: ['unity', 'unreal', 'godot'].includes(engine.id) && display.mode === 'fullscreen' ? 'app' : display.mode,
    verification: 'awaiting-application-test' };
}

module.exports = { compatibilityInfo, validateCompatibility, resolveEngine, buildEngineLaunchPlan, winePath };

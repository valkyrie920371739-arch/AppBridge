'use strict';

// Only structured preferences cross this bridge; the main process validates
// them and owns engine detection and the literal launch arguments.
window.AppCompatibilityPanel = (() => {
  const $ = (id) => document.getElementById(id);
  const engineIds = new Set(['auto', 'unity', 'unreal', 'godot', 'renpy', 'rpgmaker', 'tyrano', 'unknown']);
  const graphicsLabels = { auto: '自动（推荐）', game: '跟随程序', d3d11: 'Direct3D 11', opengl: 'OpenGL 兼容模式' };
  let hooks = null;
  let selectedId = null;
  let initialGame = null;
  let saving = false;
  let previousFocus = null;

  function currentGame() {
    const games = hooks?.getState?.()?.games;
    return Array.isArray(games) ? games.find((game) => game.id === selectedId) : initialGame;
  }

  function effectiveEngine(game) {
    const selected = $('compatibility-engine').value;
    return selected !== 'auto' ? selected : game?.compatibilityInfo?.engineId || game?.engineProfile?.id || 'unknown';
  }

  function graphicsOptions(game) {
    const selected = $('compatibility-engine').value;
    const stored = game?.compatibility?.engine || 'auto';
    const provided = game?.compatibilityInfo?.graphicsOptions;
    if (selected === stored && Array.isArray(provided) && provided.length) {
      const values = [...new Set(provided.map((option) => option?.value).filter((value) => Object.hasOwn(graphicsLabels, value)))];
      if (values.includes('auto') && values.includes('game')) return values;
    }
    const engine = effectiveEngine(game);
    if (engine === 'unity' || engine === 'unreal') return ['auto', 'game', 'd3d11'];
    if (engine === 'godot') return ['auto', 'game', 'opengl'];
    return ['auto', 'game'];
  }

  function updateNote(game) {
    const engine = effectiveEngine(game);
    const graphics = $('compatibility-graphics').value;
    const storedEngine = game?.compatibility?.engine || 'auto';
    const providedNote = $('compatibility-engine').value === storedEngine && typeof game?.compatibilityInfo?.note === 'string' ? game.compatibilityInfo.note : '';
    let note;
    if (graphics === 'game') note = '保留程序自己的图形接口。窗口与尺寸仍使用“显示设置”。';
    else if (graphics === 'd3d11') note = '尝试以 Direct3D 11 启动，程序需包含对应的图形支持。无法启动时，可改为“跟随程序”。';
    else if (graphics === 'opengl' && engine === 'godot') note = 'OpenGL 兼容模式需要识别 Godot 3 或 4 主版本，且程序自身包含对应支持。未识别版本时，请先使用“跟随程序”。';
    else if (engine === 'unity' || engine === 'unreal' || engine === 'godot') note = providedNote || '按识别到的引擎适配显示与日志，保留程序的图形接口。兼容情况以实际运行结果为准。';
    else note = '使用通用启动方式，不添加其他引擎的图形参数。识别不准确时，可手动选择引擎。';
    $('compatibility-help').textContent = note;
  }

  function updateGraphics() {
    const game = currentGame();
    const selected = $('compatibility-graphics').value;
    const values = graphicsOptions(game);
    const options = values.map((value) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = graphicsLabels[value];
      return option;
    });
    $('compatibility-graphics').replaceChildren(...options);
    $('compatibility-graphics').value = values.includes(selected) ? selected : 'auto';
    updateNote(game);
  }

  function setError(text = '') {
    $('compatibility-error').textContent = text;
    $('compatibility-error').hidden = !text;
    if (text) $('compatibility-error').focus({ preventScroll: false });
  }

  function isActive(game) {
    return Boolean(game && (game.running || game.launching || game.relocating || hooks?.isPending?.(game.id)));
  }

  function refresh() {
    if (!hooks || !selectedId) return;
    const game = currentGame();
    const active = isActive(game);
    $('compatibility-app-name').textContent = String(game?.title || initialGame?.title || '应用').replace(/\.exe$/i, '');
    const detected = game?.engineProfile?.name || game?.compatibilityInfo?.detectedEngineName;
    $('compatibility-detected').textContent = detected && game?.engineProfile?.id !== 'unknown' ? '识别引擎：' + detected : '尚未可靠识别引擎，可手动选择。';
    $('compatibility-fields').disabled = saving || active || !game;
    $('compatibility-save').disabled = saving || active || !game;
    $('compatibility-save-label').textContent = saving ? '正在保存…' : '保存设置';
    $('compatibility-form').setAttribute('aria-busy', String(saving));
    $('compatibility-locked').hidden = !active;
    $('compatibility-unavailable').hidden = Boolean(game);
    for (const button of $('compatibility-dialog').querySelectorAll('.close-dialog')) button.disabled = saving;
    // A background library refresh must not replace unsaved selections.
    updateNote(game);
  }

  async function save(event) {
    event.preventDefault();
    const game = currentGame();
    if (!game || saving) return;
    if (isActive(game)) { setError('请先关闭应用并等待文件操作完成，再修改兼容设置。'); refresh(); return; }
    const options = { engine: $('compatibility-engine').value, graphics: $('compatibility-graphics').value };
    if (!engineIds.has(options.engine) || !graphicsOptions(game).includes(options.graphics)) { setError('请选择此引擎可用的图形模式。'); return; }
    setError(); saving = true; refresh();
    try {
      const saved = await hooks.request(window.player.compatibility(game.id, options));
      game.compatibility = saved;
      let refreshError = null;
      try {
        const value = await hooks.request(window.player.state());
        hooks.onState?.(value);
      } catch (error) { refreshError = error; }
      $('compatibility-dialog').close();
      hooks.message?.(refreshError ? '兼容设置已保存，但资料库未能刷新。重新打开设置后查看。' : '兼容设置已保存，下次启动时应用。', Boolean(refreshError));
    } catch (error) {
      setError(error.message || String(error));
    } finally { saving = false; refresh(); }
  }

  function open(game, options) {
    if (saving) { hooks?.message?.('正在保存兼容设置，请稍候。'); return false; }
    if (!game || game.kind !== 'windows' || typeof game.id !== 'string') return false;
    if (typeof options?.request !== 'function' || typeof options?.showDialog !== 'function') throw new TypeError('兼容设置缺少应用接口。');
    hooks = options; selectedId = game.id; initialGame = game;
    previousFocus = document.activeElement;
    for (const dialog of document.querySelectorAll('.panel-dialog[open]')) if (dialog.id !== 'compatibility-dialog') dialog.close();
    const saved = currentGame()?.compatibility || {};
    $('compatibility-engine').value = engineIds.has(saved.engine) ? saved.engine : 'auto';
    updateGraphics();
    $('compatibility-graphics').value = graphicsOptions(currentGame()).includes(saved.graphics) ? saved.graphics : 'auto';
    setError(); refresh(); hooks.showDialog('compatibility-dialog');
    return true;
  }

  $('compatibility-form').addEventListener('submit', save);
  $('compatibility-engine').addEventListener('change', () => { setError(); updateGraphics(); });
  $('compatibility-graphics').addEventListener('change', () => { setError(); updateNote(currentGame()); });
  $('compatibility-dialog').addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  $('compatibility-dialog').addEventListener('click', (event) => { if (saving && event.target === $('compatibility-dialog')) event.stopImmediatePropagation(); }, true);
  $('compatibility-dialog').addEventListener('close', () => {
    if (previousFocus?.isConnected && !previousFocus.closest?.('dialog:not([open])')) previousFocus.focus({ preventScroll: true });
    else document.querySelector('.app-card.selected .card-main')?.focus({ preventScroll: true });
  });

  return Object.freeze({ open, refresh });
})();

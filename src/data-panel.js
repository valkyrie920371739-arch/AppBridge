'use strict';

// UI only: folder selection, checks and copying stay in the main process.
window.AppDataPanel = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks = null;
  let selectedId = null;
  let initialGame = null;
  let phase = null;
  let previousFocus = null;
  const backups = new Map();

  function currentGame() {
    const games = hooks?.getState?.()?.games;
    return Array.isArray(games) ? games.find((game) => game.id === selectedId) : initialGame;
  }

  function notify(text, error = false) {
    if (hooks?.message) hooks.message(text, error);
  }

  function buttonContent(id, label, iconName, spinning = false) {
    const button = $(id);
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = window.AppIcons?.[iconName] || '';
    if (spinning) icon.className = 'loading-icon';
    const text = document.createElement('span');
    text.textContent = label;
    button.replaceChildren(icon, text);
  }

  function refresh() {
    if (!hooks || !selectedId) return;
    const game = currentGame();
    const moving = phase === 'relocating';
    const active = Boolean(game && (game.running || game.launching || game.relocating));
    const location = typeof game?.saveDirectory === 'string' ? game.saveDirectory : '';
    $('data-app-name').textContent = String(game?.title || initialGame?.title || '应用').replace(/\.exe$/i, '');
    // Do not replace the path field: users may be selecting/copying its text.
    if ($('data-location-path').value !== location) $('data-location-path').value = location;
    $('data-open-location').disabled = Boolean(phase) || !location || !game;
    $('data-change-location').disabled = Boolean(phase) || active || !location || !game;
    $('data-location-locked').hidden = !active || moving;
    $('data-location-unavailable').hidden = Boolean(game);
    $('data-location-progress').hidden = !moving;
    $('data-location-controls').setAttribute('aria-busy', String(Boolean(phase)));
    for (const button of $('data-dialog').querySelectorAll('.close-dialog')) button.disabled = moving;
    buttonContent('data-open-location', phase === 'opening' ? '正在打开…' : '打开文件夹', phase === 'opening' ? 'LoaderCircle' : 'FolderOpen', phase === 'opening');
    buttonContent('data-change-location', moving ? '正在处理…' : '更改存放位置…', moving ? 'LoaderCircle' : 'FolderOpen', moving);
    const backup = backups.get(selectedId) || game?.previousDataDirectory;
    $('data-backup-note').hidden = !backup;
    $('data-backup-path').textContent = backup || '';
  }

  async function openLocation() {
    const game = currentGame();
    if (!game || phase) return;
    phase = 'opening'; refresh();
    try { await hooks.request(window.player.saves(game.id)); }
    catch (error) { notify(error.message || String(error), true); }
    finally { phase = null; refresh(); }
  }

  async function changeLocation() {
    const game = currentGame();
    if (!game || phase) return;
    if (game.running || game.launching || game.relocating) {
      notify('请先关闭应用，再更改数据与存档的存放位置。', true);
      refresh(); return;
    }
    phase = 'relocating'; refresh();
    try {
      const result = await hooks.request(window.player.relocateData(game.id));
      if (!result || result.canceled) return;
      // Retain a truthful new location even if a subsequent library refresh
      // fails; report that separately without retrying a completed migration.
      if (typeof result.saveDirectory === 'string') {
        game.saveDirectory = result.saveDirectory;
        if (initialGame?.id === game.id) initialGame.saveDirectory = result.saveDirectory;
      }
      if (typeof result.backupDirectory === 'string') backups.set(game.id, result.backupDirectory);
      try {
        const value = await hooks.request(window.player.state());
        if (hooks.onState) hooks.onState(value);
      } catch (error) {
        notify('存放位置已切换，但界面更新失败。请重新打开此窗口查看。' + (error.message ? `\n${error.message}` : ''), true);
        return;
      }
      notify(result.unchanged ? '当前已经使用这个存放位置。' : '数据存放位置已切换，原位置的备份已保留。');
    } catch (error) {
      notify(error.message || String(error), true);
    } finally {
      phase = null; refresh();
    }
  }

  function open(game, options) {
    if (phase) { notify('正在处理数据文件，请稍候。'); return false; }
    if (!game || typeof game.id !== 'string') return false;
    if (typeof options?.request !== 'function' || typeof options?.showDialog !== 'function') throw new TypeError('数据窗口缺少应用接口。');
    hooks = options; selectedId = game.id; initialGame = game;
    // Keep one modal active so the shared status message is shown inside this
    // panel when it was opened from an application's information dialog.
    for (const dialog of document.querySelectorAll('.panel-dialog[open]')) {
      if (dialog.id !== 'data-dialog') dialog.close();
    }
    previousFocus = document.activeElement;
    refresh();
    hooks.showDialog('data-dialog');
    return true;
  }

  $('data-open-location').addEventListener('click', openLocation);
  $('data-change-location').addEventListener('click', changeLocation);
  $('data-dialog').addEventListener('cancel', (event) => { if (phase === 'relocating') event.preventDefault(); });
  // Existing dialog backdrop behavior is shared by renderer.js. A copy in
  // progress cannot be dismissed through that shared listener.
  $('data-dialog').addEventListener('click', (event) => {
    if (phase === 'relocating' && event.target === $('data-dialog')) event.stopImmediatePropagation();
  }, true);
  $('data-dialog').addEventListener('close', () => {
    if (phase === 'relocating') return;
    if (previousFocus?.isConnected && !previousFocus.closest?.('dialog:not([open])')) previousFocus.focus({ preventScroll: true });
    else document.querySelector('.app-card.selected .card-main')?.focus({ preventScroll: true });
  });

  return Object.freeze({ open, refresh });
})();

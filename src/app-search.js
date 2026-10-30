'use strict';
(function (root) {
  function normalized(value) {
    return String(value || '').normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
  }
  function containsInOrder(name, query) {
    if (query.length < 2 || query.length > name.length) return false;
    let index = 0;
    for (const letter of name) if (letter === query[index] && ++index === query.length) return true;
    return false;
  }
  function matchesApplicationQuery(game, input) {
    const raw = String(input || '').trim();
    if (!raw) return true;
    const query = normalized(raw);
    if (!query || query.length > 256) return false;
    const executable = String(game.exePath || '').split(/[\\/]/).at(-1);
    return [game.title, executable].filter(Boolean).some((value) => {
      const name = normalized(value);
      return name.includes(query) || containsInOrder(name, query);
    });
  }
  const api = Object.freeze({ matchesApplicationQuery });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AppSearch = api;
})(typeof window === 'undefined' ? globalThis : window);

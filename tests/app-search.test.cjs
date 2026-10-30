'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesApplicationQuery: matches } = require('../src/app-search.js');
const game = { title: 'ReSister.exe', exePath: '/library/ReSister/ReSister.exe' };
test('application search accepts partial names, case, spaces and punctuation', () => {
  for (const query of ['re', 'sister', 'SISTER', 'Re Sister', 're:sister', 'ＲｅＳｉｓｔｅｒ', 're-sis', 'rs', 'rstr']) assert.equal(matches(game, query), true, query);
});
test('application search preserves Chinese names and matches original executable after a title change', () => {
  assert.equal(matches({title:'姐妹的冒险'}, '姐妹'), true);
  assert.equal(matches({...game,title:'我的游戏'}, 'sister'), true);
  assert.equal(matches({title:'Café Manager'}, 'cafe'), true);
});
test('application search rejects unrelated names and nonempty symbol-only searches', () => {
  for (const query of ['different-app', 'sisterre', '[]', 'a'.repeat(257)]) assert.equal(matches(game, query), false, query);
  assert.equal(matches(game, ''), true);
  assert.equal(matches(game, '  '), true);
});

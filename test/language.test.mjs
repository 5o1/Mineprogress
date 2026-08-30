import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONTENT_LANGUAGE,
  normalizeContentLanguage,
  validateContentLanguage
} from '../src/backend/language.mjs';

test('content language defaults to English and normalizes explicit tags', () => {
  assert.equal(DEFAULT_CONTENT_LANGUAGE, 'en');
  assert.equal(normalizeContentLanguage(), 'en');
  assert.equal(normalizeContentLanguage('ZH-CN'), 'zh-cn');
  assert.throws(() => normalizeContentLanguage('../zh'), { code: 'CONTENT_LANGUAGE_INVALID' });
});

test('static language checks reject supported marker mismatches', () => {
  assert.deepEqual(validateContentLanguage('Repository integration is complete.', 'en'), []);
  assert.match(validateContentLanguage('仓库集成已经完成。', 'en').join(' '), /content language en/);
  assert.deepEqual(validateContentLanguage('仓库集成已经完成。', 'zh-cn'), []);
  assert.match(validateContentLanguage('Repository integration is complete.', 'zh-cn').join(' '), /content language zh-cn/);
});

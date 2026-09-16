import assert from 'node:assert/strict';
import test from 'node:test';

import { safeMarkdownHref } from './markdownHref';

test('Given http, mailto, tel, or an in-page anchor, when classified, then the href is kept', () => {
  assert.equal(safeMarkdownHref('https://example.test/docs'), 'https://example.test/docs');
  assert.equal(safeMarkdownHref('http://127.0.0.1:3021'), 'http://127.0.0.1:3021');
  assert.equal(safeMarkdownHref('mailto:owner@example.test'), 'mailto:owner@example.test');
  assert.equal(safeMarkdownHref('tel:+15551212'), 'tel:+15551212');
  assert.equal(safeMarkdownHref('#approval'), '#approval');
});

test('Given data, javascript, or an unknown scheme, when classified, then the href is dropped', () => {
  assert.equal(safeMarkdownHref('data:text/html,<h1>Login</h1>'), null);
  assert.equal(safeMarkdownHref('javascript:alert(1)'), null);
  assert.equal(safeMarkdownHref('vbscript:msgbox(1)'), null);
  assert.equal(safeMarkdownHref('file:///etc/passwd'), null);
  assert.equal(safeMarkdownHref(''), null);
  assert.equal(safeMarkdownHref(undefined), null);
});

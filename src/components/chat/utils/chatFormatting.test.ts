import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

import { normalizeLatexMathDelimiters } from './chatFormatting';

test('normalizes paired LaTeX display and inline delimiters for remark-math', () => {
  assert.equal(
    normalizeLatexMathDelimiters('\\[\n\\text{보정값} \\approx E[\\text{weight 오차} \\times \\text{입력 특징}]\n\\]'),
    '$$\n\\text{보정값} \\approx E[\\text{weight 오차} \\times \\text{입력 특징}]\n$$',
  );
  assert.equal(normalizeLatexMathDelimiters('값은 \\(x \\times y\\) 입니다.'), '값은 $x \\times y$ 입니다.');
});

test('leaves LaTeX delimiters in Markdown code and unmatched input unchanged', () => {
  const markdown = [
    '`\\(inline code\\)`',
    '```latex',
    '\\[fenced code\\]',
    '```',
    '    \\(indented code\\)',
    '\\[unmatched',
    String.raw`escaped \\[literal\\]`,
  ].join('\n');
  assert.equal(normalizeLatexMathDelimiters(markdown), markdown);
});

test('does not let an unmatched inline delimiter consume a later fenced code block', () => {
  const markdown = [
    'Group with \\( in BRE.',
    '',
    '```sh',
    String.raw`sed 's/\(foo\)/bar/' file`,
    '```',
  ].join('\n');
  assert.equal(normalizeLatexMathDelimiters(markdown), markdown);
});

test('normalizes display math with space- or tab-indented bodies', () => {
  const spaced = [
    '\\[',
    '    \\begin{aligned}',
    '        a &= b \\\\',
    '        c &= d',
    '    \\end{aligned}',
    '\\]',
  ].join('\n');
  assert.equal(normalizeLatexMathDelimiters(spaced), [
    '$$',
    '    \\begin{aligned}',
    '        a &= b \\\\',
    '        c &= d',
    '    \\end{aligned}',
    '$$',
  ].join('\n'));

  const tabbed = ['\\[', '\t\\begin{bmatrix}', '\t\ta & b', '\t\\end{bmatrix}', '\\]'].join('\n');
  assert.equal(
    normalizeLatexMathDelimiters(tabbed),
    ['$$', '\t\\begin{bmatrix}', '\t\ta & b', '\t\\end{bmatrix}', '$$'].join('\n'),
  );
});

test('keeps escaped Markdown brackets while accepting unambiguous display math', () => {
  const references = 'See \\[1\\] and \\[2\\].';
  assert.equal(normalizeLatexMathDelimiters(references), references);
  const option = 'Usage: cmd \\[--flag=value\\]';
  assert.equal(normalizeLatexMathDelimiters(option), option);
  assert.equal(normalizeLatexMathDelimiters('Equation: \\[E = mc^2\\].'), 'Equation: $$E = mc^2$$.');
  assert.equal(normalizeLatexMathDelimiters('\\[x\\]'), '$$x$$');
});

test('normalizes ordinary inline math while preserving slash-delimited BRE groups', () => {
  const sed = String.raw`Run sed 's/\(foo\)/bar/' to rename.`;
  assert.equal(normalizeLatexMathDelimiters(sed), sed);
  const slashAfter = String.raw`Pattern \(foo\)/bar`;
  assert.equal(normalizeLatexMathDelimiters(slashAfter), slashAfter);
  assert.equal(normalizeLatexMathDelimiters('원소가 \\(n\\)개 있습니다.'), '원소가 $n$개 있습니다.');
  assert.equal(normalizeLatexMathDelimiters('value \\(x+1\\) done'), 'value $x+1$ done');
  assert.equal(normalizeLatexMathDelimiters('when \\(x = y\\) holds'), 'when $x = y$ holds');
  assert.equal(normalizeLatexMathDelimiters('points \\(a, b\\) given'), 'points $a, b$ given');
  assert.equal(normalizeLatexMathDelimiters('값은 \\(x \\times y\\) 입니다.'), '값은 $x \\times y$ 입니다.');
  assert.equal(normalizeLatexMathDelimiters('\\(x\\)'), '$x$');
});

test('normalizes long backslash runs without superlinear slowdown', () => {
  const markdown = '\\'.repeat(100_000);
  const plain = 'a'.repeat(markdown.length);
  const plainStartedAt = performance.now();
  assert.equal(normalizeLatexMathDelimiters(plain), plain);
  const plainElapsedMs = performance.now() - plainStartedAt;
  const slashStartedAt = performance.now();
  assert.equal(normalizeLatexMathDelimiters(markdown), markdown);
  const slashElapsedMs = performance.now() - slashStartedAt;
  const limitMs = Math.max(250, plainElapsedMs * 50);
  assert.ok(
    slashElapsedMs < limitMs,
    `backslashes took ${slashElapsedMs.toFixed(1)} ms vs ${plainElapsedMs.toFixed(1)} ms for plain text`,
  );
});

test('renders Codex backslash display math through KaTeX without dropping command prefixes', () => {
  const content = normalizeLatexMathDelimiters(
    '\\[\n\\text{보정값} \\approx E[\\text{weight 오차} \\times \\text{입력 특징}]\n\\]',
  );
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeKatex],
    }, content),
  );
  assert.ok(html.includes('class="katex-display"'));
  assert.ok(html.includes('보정값'));
  assert.ok(html.includes('weight 오차'));
  assert.ok(html.includes('입력 특징'));
  assert.ok(html.includes('annotation encoding="application/x-tex"'));
});

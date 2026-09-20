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

test('keeps escaped Markdown brackets while accepting unambiguous display math', () => {
  const references = 'See \\[1\\] and \\[2\\].';
  assert.equal(normalizeLatexMathDelimiters(references), references);
  assert.equal(normalizeLatexMathDelimiters('Equation: \\[x = y\\].'), 'Equation: $$x = y$$.');
  assert.equal(normalizeLatexMathDelimiters('\\[x\\]'), '$$x$$');
});

test('normalizes long backslash runs in linear time', () => {
  const markdown = '\\'.repeat(100_000);
  const startedAt = performance.now();
  assert.equal(normalizeLatexMathDelimiters(markdown), markdown);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 2_000, `normalization took ${elapsedMs.toFixed(1)} ms`);
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

import assert from 'node:assert/strict';
import test from 'node:test';

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

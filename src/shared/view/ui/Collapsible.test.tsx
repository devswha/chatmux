import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Collapsible, CollapsibleContent } from './Collapsible';

const renderCollapsible = (
  defaultOpen: boolean,
  unmountOnClose: boolean,
): string => renderToStaticMarkup(createElement(
  Collapsible,
  { defaultOpen },
  createElement(
    CollapsibleContent,
    { unmountOnClose },
    createElement('span', null, 'expensive-result'),
  ),
));

test('unmountOnClose omits closed disclosure content from the DOM', () => {
  assert.doesNotMatch(renderCollapsible(false, true), /expensive-result/);
});

test('unmountOnClose renders disclosure content when initially open', () => {
  assert.match(renderCollapsible(true, true), /expensive-result/);
});

test('closed disclosures preserve existing mounted-content behavior by default', () => {
  assert.match(renderCollapsible(false, false), /expensive-result/);
});

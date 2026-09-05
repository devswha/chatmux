import assert from 'node:assert/strict';
import test from 'node:test';

import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

import ShellConnectionOverlay from './ShellConnectionOverlay';

const labels = {
  description: 'Ready to connect to the selected terminal.',
  loadingLabel: 'Loading terminal…',
  connectLabel: 'Connect terminal',
  connectTitle: 'Connect to the selected terminal',
  connectingLabel: 'Connecting…',
};

test('connection modes update one polite status region without requesting focus or including the connect button', async (t) => {
  let connects = 0;
  const onConnect = () => { connects += 1; };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ShellConnectionOverlay {...labels} mode="loading" onConnect={onConnect} />);
  });
  t.after(() => act(() => renderer.unmount()));
  const status = renderer.root.findByProps({ role: 'status' });

  for (const [mode, expected] of [
    ['loading', labels.loadingLabel],
    ['connecting', labels.connectingLabel],
    ['connect', labels.description],
    ['connecting', labels.connectingLabel],
  ] as const) {
    await act(async () => renderer.update(<ShellConnectionOverlay {...labels} mode={mode} onConnect={onConnect} />));
    assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 1);
    assert.equal(renderer.root.findByProps({ role: 'status' }), status);
    assert.equal(status.props['aria-live'], 'polite');
    assert.equal(status.props['aria-atomic'], 'true');
    assert.deepEqual(status.findByType('span').children, [expected]);
    assert.equal(status.findAllByType('button').length, 0);
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(renderer.root.findAll((node) => node.props.autoFocus || node.props.tabIndex !== undefined).length, 0);
    assert.equal(connects, 0);

    const buttons = renderer.root.findAllByType('button');
    assert.equal(buttons.length, mode === 'connect' ? 1 : 0);
    for (const icon of renderer.root.findAllByType('svg')) {
      assert.equal(icon.props['aria-hidden'], 'true');
    }
  }
});

test('connect remains a native button with one callback per activation', async (t) => {
  let connects = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ShellConnectionOverlay {...labels} mode="connect" onConnect={() => { connects += 1; }} />,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  const button = renderer.root.findByType('button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.title, labels.connectTitle);
  assert.deepEqual(button.findByType('span').children, [labels.connectLabel]);
  assert.equal(button.props.onPointerDown, undefined);
  assert.equal(button.props.onKeyDown, undefined);
  assert.equal(button.props.onKeyUp, undefined);
  assert.equal(connects, 0);
  await act(async () => button.props.onClick());
  assert.equal(connects, 1);
});

test('long connection labels can wrap within mobile and desktop overlay widths', () => {
  for (const mode of ['loading', 'connect', 'connecting'] as const) {
    const markup = renderToStaticMarkup(
      <ShellConnectionOverlay
        {...labels}
        mode={mode}
        loadingLabel={'Loading '.repeat(20)}
        connectLabel={'Connect '.repeat(20)}
        connectingLabel={'Connecting '.repeat(20)}
        onConnect={() => {}}
      />,
    );
    assert.match(markup, /w-full min-w-0 max-w-md/);
    assert.match(markup, /min-w-0 break-words/);
    assert.match(markup, /shrink-0/);
    assert.doesNotMatch(markup, /\btruncate\b|\bwhitespace-nowrap\b/);
  }
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import type { ComponentProps } from 'react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';
import type { Terminal } from '@xterm/xterm';

import TerminalShortcutsPanel from './TerminalShortcutsPanel';

type PanelProps = ComponentProps<typeof TerminalShortcutsPanel>;
const localesRoot = new URL('../../../../i18n/locales/', import.meta.url);

function readSettings(language: string) {
  return JSON.parse(readFileSync(new URL(`${language}/settings.json`, localesRoot), 'utf8'));
}

async function panelElement(props: Partial<PanelProps> = {}, language = 'en') {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: { [language]: { settings: readSettings(language) } },
    interpolation: { escapeValue: false },
  });
  return (
    <I18nextProvider i18n={i18n}>
      <TerminalShortcutsPanel
        wsRef={{ current: null }}
        terminalRef={{ current: null }}
        isConnected
        {...props}
      />
    </I18nextProvider>
  );
}

async function mountPanel(t: TestContext, props: Partial<PanelProps> = {}) {
  const element = await panelElement(props);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element); });
  t.after(() => act(() => renderer.unmount()));
  return renderer;
}

function socketRecorder() {
  const messages: unknown[] = [];
  const wsRef = {
    current: {
      readyState: WebSocket.OPEN,
      send: (data: string) => { messages.push(JSON.parse(data)); },
    } as WebSocket,
  };
  return { messages, wsRef };
}

test('mobile terminal shortcuts reserve layout space and horizontal scrolling below the desktop breakpoint', async (t) => {
  const renderer = await mountPanel(t);
  const classes = renderer.root.findAllByType('div').map((node) => node.props.className).join(' ');

  assert.match(classes, /pointer-events-none z-20 shrink-0/);
  assert.match(classes, /pb-safe-area-inset-bottom/);
  assert.match(classes, /md:hidden/);
  assert.match(classes, /overflow-x-auto/);
  assert.doesNotMatch(classes, /\bfixed\b/);
  assert.doesNotMatch(classes, /\binset-x-0\b/);
  const labels = renderer.root.findAllByType('button').flatMap((node) => node.children);
  assert.ok(labels.includes('Esc'));
  assert.ok(labels.includes('Tab'));
});

for (const locale of readdirSync(localesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  test(`terminal arrow labels use the shipped ${locale.name} translations`, async (t) => {
    const settings = readSettings(locale.name);
    const element = await panelElement({}, locale.name);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(element); });
    t.after(() => act(() => renderer.unmount()));
    const buttons = renderer.root.findAllByType('button');

    for (const key of ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight']) {
      const label = settings.terminalShortcuts[key];
      assert.equal(typeof label, 'string');
      assert.ok(label.trim().length > 0);
      const button = buttons.find((entry) => entry.props['aria-label'] === label);
      assert.ok(button, `missing accessible button for ${key}`);
      assert.equal(button.props.title, label);
      assert.equal(button.findByType('svg').props['aria-hidden'], 'true');
      assert.equal(button.props['aria-pressed'], undefined);
    }

    assert.equal(new Set(['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight']
      .map((key) => settings.terminalShortcuts[key])).size, 4);
    assert.ok(buttons.some((button) => button.props['aria-label'] === (settings.terminalShortcuts.paste ?? 'Paste')));
    assert.ok(buttons.some((button) => button.props['aria-label'] === settings.terminalShortcuts.scrollDown));
  });
}

test('Ctrl and Alt expose independent pressed states and reset after one key activation', async (t) => {
  const { messages, wsRef } = socketRecorder();
  const renderer = await mountPanel(t, { wsRef });
  const button = (label: string) => renderer.root.findAllByType('button')
    .find((entry) => entry.children.includes(label))!;
  const ctrl = button('CTRL');
  const alt = button('ALT');

  assert.equal(ctrl.props['aria-pressed'], false);
  assert.equal(alt.props['aria-pressed'], false);
  await act(async () => ctrl.props.onClick());
  assert.equal(ctrl.props['aria-pressed'], true);
  assert.equal(alt.props['aria-pressed'], false);
  await act(async () => ctrl.props.onClick());
  assert.equal(ctrl.props['aria-pressed'], false);
  await act(async () => {
    ctrl.props.onClick();
    alt.props.onClick();
  });
  assert.equal(ctrl.props['aria-pressed'], true);
  assert.equal(alt.props['aria-pressed'], true);
  assert.deepEqual(messages, []);

  await act(async () => button('Tab').props.onClick());
  assert.deepEqual(messages, [{ type: 'input', data: '\x1b\t' }]);
  assert.equal(ctrl.props['aria-pressed'], false);
  assert.equal(alt.props['aria-pressed'], false);
  await act(async () => button('Tab').props.onClick());
  assert.deepEqual(messages, [{ type: 'input', data: '\x1b\t' }, { type: 'input', data: '\t' }]);
});

test('pointer presses preserve terminal focus and clicks send each key exactly once to the supplied socket', async (t) => {
  const { messages, wsRef } = socketRecorder();
  let scrolls = 0;
  const terminalRef = { current: { scrollToBottom: () => { scrolls += 1; } } as Terminal };
  const renderer = await mountPanel(t, { wsRef, terminalRef });
  const buttons = renderer.root.findAllByType('button');

  for (const button of buttons) {
    let prevented = 0;
    await act(async () => button.props.onPointerDown({ preventDefault: () => { prevented += 1; } }));
    assert.equal(prevented, 1);
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.onKeyDown, undefined);
    assert.equal(button.props.onKeyUp, undefined);
    assert.equal(button.props.tabIndex, undefined);
  }
  assert.deepEqual(messages, []);
  assert.equal(scrolls, 0);

  for (const [label, sequence] of [
    ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'],
    ['Arrow Up', '\x1b[A'], ['Arrow Down', '\x1b[B'],
    ['Arrow Left', '\x1b[D'], ['Arrow Right', '\x1b[C'], ['Ctrl+C', '\x03'],
  ]) {
    const button = buttons.find((entry) => entry.props['aria-label'] === label || entry.children.includes(label))!;
    const before: number = messages.length;
    await act(async () => button.props.onClick());
    assert.equal(messages.length, before + 1);
    assert.deepEqual(messages.at(-1), { type: 'input', data: sequence });
  }

  const scroll = buttons.find((button) => button.props['aria-label'] === 'Scroll Down')!;
  await act(async () => scroll.props.onClick());
  assert.equal(scrolls, 1);
  assert.equal(messages.length, 8);
});

test('disconnected controls stay disabled and a closed socket receives no shortcut input', async (t) => {
  const { messages, wsRef } = socketRecorder();
  const renderer = await mountPanel(t, { wsRef, isConnected: false });
  for (const button of renderer.root.findAllByType('button')) {
    assert.equal(button.props.disabled, true);
  }
  assert.deepEqual(messages, []);

  wsRef.current = { ...wsRef.current, readyState: WebSocket.CLOSED } as WebSocket;
  const connectedElement = await panelElement({ wsRef, isConnected: true });
  await act(async () => renderer.update(connectedElement));
  const arrow = renderer.root.findAllByType('button')
    .find((button) => button.props['aria-label'] === 'Arrow Up')!;
  await act(async () => arrow.props.onClick());
  assert.deepEqual(messages, []);
});

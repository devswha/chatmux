#!/usr/bin/env python3
"""Exercise additive settings/navigation features in the owned CUA fixture.

Uses disposable browser contexts and synthetic transcripts. Clipboard writes are
captured inside the test page; nothing reaches the operator's clipboard or agents.
Mobile cases are browser emulation, not physical phone/screen-reader evidence.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SESSION = '019f0000-0000-7000-8000-000000000103'


def check_excerpt(page, mobile, evidence, case_name, checks):
    trigger = page.get_by_role('button', name='Copy conversation excerpt', exact=True)
    expect(trigger).to_be_visible(timeout=30_000)
    trigger.tap() if mobile else trigger.click()
    dialog = page.get_by_role('dialog', name='Copy conversation excerpt', exact=True)
    expect(dialog).to_be_visible()
    boxes = dialog.get_by_role('checkbox')
    assert boxes.count() > 0
    expect(dialog.get_by_role('button', name='Review selection (0)', exact=True)).to_be_disabled()
    boxes.first.check()
    dialog.get_by_role('button', name='Review selection (1)', exact=True).click()
    preview = dialog.get_by_role('textbox')
    expect(preview).to_contain_text('Selected conversation excerpt')
    reviewed = 'Reviewed excerpt\nNext step: verify the change.'
    preview.fill(reviewed)
    dialog.get_by_role('button', name='Copy reviewed excerpt', exact=True).click()
    expect(dialog.get_by_role('status')).to_have_text('Excerpt copied.')
    assert page.evaluate('window.__excerptCopied') == reviewed
    checks['excerpt_selection_review_and_copy'] = True
    page.screenshot(path=str(evidence / f'{case_name}-excerpt.png'))
    if mobile:
        original = page.viewport_size
        page.set_viewport_size({'width': 844, 'height': 340})
        box, viewport = dialog.bounding_box(), page.viewport_size
        assert box['x'] >= 0 and box['y'] >= 0
        assert box['x'] + box['width'] <= viewport['width'] + 1
        assert box['y'] + box['height'] <= viewport['height'] + 1
        expect(dialog.get_by_role('button', name='Copy reviewed excerpt', exact=True)).to_be_in_viewport()
        page.set_viewport_size(original)
        checks['excerpt_short_landscape'] = True
    dialog.get_by_role('button', name='Close', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(trigger).to_be_focused()
    trigger.click()
    expect(page.get_by_role('checkbox').first).not_to_be_checked()
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    checks['excerpt_close_reset_focus_and_escape'] = True


def activate(locator, mobile):
    locator.tap() if mobile else locator.click()


def open_sidebar(page, mobile):
    if not mobile:
        return
    close = page.get_by_role('button', name='Close sidebar', exact=True)
    # Computed visibility stays true during a closing transition. Inspect the
    # requested state, then wait for the opening panel to reach the viewport.
    requested_open = close.count() > 0 and close.evaluate("node => node.parentElement.classList.contains('visible')")
    if not requested_open:
        page.get_by_role('button', name='Open menu', exact=True).tap()
    panel = close.locator('xpath=following-sibling::div[1]')
    expect(panel).to_be_in_viewport(ratio=1)


def failed_read(status, code):
    def fulfill(route):
        route.fulfill(status=status, json={'error': code})
    return fulfill


def check_pins(page, mobile, manifest, evidence, name, checks):
    def palette():
        expect(page.locator('textarea').first).to_be_visible(timeout=30_000)
        activate(page.get_by_role('button', name='Search and pinned sessions', exact=True), mobile)
        dialog = page.get_by_role('dialog', name='Command palette', exact=True)
        expect(dialog).to_be_visible()
        return dialog

    dialog = palette()
    current = dialog.get_by_role('button', name='Pin current session', exact=True)
    expect(current).to_be_enabled()
    activate(current, mobile)
    expect(dialog.get_by_role('button', name='Unpin current session', exact=True)).to_have_attribute('aria-pressed', 'true')
    local_host = page.locator('[data-host-local="true"]').get_attribute('data-host-id')
    expect(dialog.get_by_role('group', name='Pinned sessions', exact=True)).to_be_visible()
    activate(dialog.get_by_role('button', name='Close', exact=True), mobile)
    page.reload(wait_until='domcontentloaded')
    dialog = palette()
    expect(dialog.get_by_role('button', name='Unpin current session', exact=True)).to_have_attribute('aria-pressed', 'true')
    activate(dialog.get_by_role('button', name='Close', exact=True), mobile)
    # The pairing result owns the installation ID; the harness node's synthetic
    # hostId is not the identity the running peer generated during bootstrap.
    peer = manifest['fleet']['enrollment']['peers'][0]['hostId']
    session = manifest['fleet']['collision']['appSessionId']
    page.goto(f"{manifest['baseUrl']}/hosts/{peer}/session/{session}", wait_until='domcontentloaded')
    dialog = palette()
    current = dialog.get_by_role('button', name='Pin current session', exact=True)
    expect(current).to_be_enabled(timeout=30_000)
    activate(current, mobile)
    group = dialog.get_by_role('group', name='Pinned sessions', exact=True)
    expect(group.get_by_role('option')).to_have_count(2)
    activate(group.get_by_role('option').filter(has_text=local_host), mobile)
    expect(page).to_have_url(f"{manifest['baseUrl']}/session/{SESSION}")
    dialog = palette()
    expect(dialog.get_by_role('group', name='Pinned sessions', exact=True).get_by_role('option')).to_have_count(2)
    page.screenshot(path=str(evidence / f'{name}-pins.png'))
    if mobile:
        original = page.viewport_size
        page.set_viewport_size({'width': 844, 'height': 340})
        box, viewport = dialog.bounding_box(), page.viewport_size
        assert box['x'] >= 0 and box['y'] >= 0
        assert box['x'] + box['width'] <= viewport['width'] + 1
        assert box['y'] + box['height'] <= viewport['height'] + 1
        expect(dialog.get_by_role('button', name='Close', exact=True)).to_be_in_viewport()
        page.set_viewport_size(original)
        checks['pins_short_landscape'] = True
    activate(dialog.get_by_role('button', name='Close', exact=True), mobile)
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Search and pinned sessions', exact=True)).to_be_focused()
    checks['pins_explicit_selection_persistence_and_cross_host_navigation'] = True
    checks['pins_close_and_focus_restore'] = True


def check_diagnostics(page, mobile, evidence, name, checks):
    open_sidebar(page, mobile)
    activate(page.get_by_role('button', name='Settings', exact=True), mobile)
    dialog = page.get_by_role('dialog', name='Settings', exact=True)
    with page.expect_response(lambda response: response.url.endswith('/api/settings/diagnostics')) as initial:
        activate(dialog.get_by_role('button', name='Diagnostics', exact=True), mobile)
    response = initial.value
    assert response.status == 200
    assert response.headers['cache-control'] == 'no-store'
    summary = response.json()
    assert summary['schemaVersion'] == 1
    for field in ['socketPath', 'transcriptPath', 'attachCapability', 'commandLine', 'privateKey', 'tmuxName']:
        assert field not in json.dumps(summary)
    heading = dialog.get_by_role('heading', name='Session discovery', exact=True)
    expect(heading).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(evidence / f'{name}-diagnostics.png'))
    refresh = dialog.get_by_role('button', name='Refresh summary', exact=True)
    for status, code in [(403, 'owner_required'), (503, 'diagnostics_unavailable')]:
        page.route('**/api/settings/diagnostics', failed_read(status, code))
        with page.expect_response(lambda response: response.url.endswith('/api/settings/diagnostics') and response.status == status):
            activate(refresh, mobile)
        expect(dialog.get_by_role('alert')).to_be_visible()
        expect(heading).to_have_count(0)
        page.unroute('**/api/settings/diagnostics')
        with page.expect_response(lambda response: response.url.endswith('/api/settings/diagnostics') and response.status == 200):
            activate(refresh, mobile)
        expect(heading).to_be_visible()
    activate(dialog.get_by_role('button', name='Close', exact=True), mobile)
    expect(dialog).to_have_count(0)
    checks['diagnostics_owner_projection_and_headers'] = True
    checks['diagnostics_denial_failure_and_recovery'] = True
    checks['diagnostics_narrow_layout'] = True


def check_attention(page, mobile, checks):
    open_sidebar(page, mobile)
    control = page.locator('[data-attention-filter-select]')
    # The fixture's idle list intentionally has no attention chrome. Mounted
    # coverage exercises report changes and keeps empty active filters resettable.
    if control.count() == 0:
        expect(page.locator('[data-attention-toolbar]')).to_have_count(0)
        expect(page.locator('[data-attention-next]')).to_have_count(0)
        expect(page.get_by_text('cua-01-omo', exact=True).first).to_be_visible()
        checks['idle_local_list_has_no_attention_toolbar'] = True
        return
    for value in ['input', 'failure', 'connection', 'all']:
        expect(control).to_be_visible()
        control.select_option(value)
        expect(control).to_have_value(value)
    expect(page.get_by_text('cua-01-omo', exact=True).first).to_be_visible()
    checks['local_attention_filters_and_restore'] = True


def check_reconnect(page, checks):
    # Capture DOM transitions before closing only this fixture page's main socket.
    page.evaluate("""() => {
      const read = () => Array.from(document.querySelectorAll('[role=status]'))
        .map(node => node.textContent).find(text => /local session list/i.test(text)) || '';
      window.__featureFreshness = [read()];
      window.__featureObserver = new MutationObserver(() => {
        const next = read();
        if (next && next !== window.__featureFreshness.at(-1)) window.__featureFreshness.push(next);
      });
      window.__featureObserver.observe(document.body, {childList:true, subtree:true, characterData:true});
      window.__featureReconnectFrameStart = window.__featureFrames.length;
      const socket = window.__featureSockets.find(socket => new URL(socket.url).pathname === '/ws' && socket.readyState === WebSocket.OPEN);
      if (!socket) throw new Error('Owned main WebSocket is unavailable');
      socket.close(1000, 'fixture reconnect check');
    }""")
    page.wait_for_function("""() => window.__featureFreshness.some(text => text.includes('Reconnecting local session list'))
      && window.__featureFreshness.at(-1).includes('Local session list up to date')""", timeout=30_000)
    kinds = page.evaluate('window.__featureFrames.slice(window.__featureReconnectFrameStart)')
    assert 'discovery.subscribe' in kinds
    forbidden = {'chat.send', 'session.spawn', 'terminal.input', 'pane.send', 'claude-command',
                 'codex-command', 'cursor-command', 'opencode-command', 'omp-command', 'omo-command', 'gjc-command'}
    assert not forbidden.intersection(kinds)
    page.evaluate('window.__featureObserver.disconnect()')
    checks['reconnect_discovery_status_and_no_write_replay'] = True


def check_terminal_accessibility(page, mobile, evidence, name, checks):
    open_sidebar(page, mobile)
    activate(page.get_by_text('cua-03-codex', exact=True).first.locator('xpath=ancestor::button[1]'), mobile)
    activate(page.get_by_role('tab', name='CLI output', exact=True), mobile)
    expect(page.locator('.xterm-screen')).to_be_visible(timeout=20_000)
    opener = page.get_by_role('button', name='Open shortcuts panel', exact=True)
    if opener.is_visible(): activate(opener, mobile)
    if mobile:
        # The on-screen shortcut strip intentionally hides at desktop widths.
        for modifier in ['CTRL', 'ALT']:
            button = page.get_by_role('button', name=modifier, exact=True)
            expect(button).to_have_attribute('aria-pressed', 'false')
            activate(button, mobile)
            expect(button).to_have_attribute('aria-pressed', 'true')
            activate(button, mobile)
            expect(button).to_have_attribute('aria-pressed', 'false')
        for direction in ['Up', 'Down', 'Left', 'Right']:
            expect(page.get_by_role('button', name=f'Arrow {direction}', exact=True)).to_be_visible()
        checks['terminal_modifier_state_and_arrow_names'] = True
    page.screenshot(path=str(evidence / f'{name}-terminal.png'))
    activate(page.get_by_role('tab', name='Chat', exact=True), mobile)
    expect(page.locator('textarea').first).to_be_visible()
    checks['terminal_attach_and_chat_roundtrip'] = True


def run_case(browser, engine, width, height, mobile, manifest, evidence):
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  is_mobile=mobile, has_touch=mobile, device_scale_factor=1, locale='en-US', service_workers='block')
    context.add_init_script("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text=>{window.__excerptCopied=text;}}})")
    context.add_init_script("""(() => {
      const OriginalSocket = window.WebSocket;
      window.__featureSockets = []; window.__featureFrames = [];
      window.WebSocket = class extends OriginalSocket {
        constructor(...args) { super(...args); window.__featureSockets.push(this); }
        send(data) {
          if (new URL(this.url).pathname === '/ws' && typeof data === 'string') {
            try { const value = JSON.parse(data); window.__featureFrames.push(value.type || value.kind || 'unknown'); } catch {}
          }
          return super.send(data);
        }
      };
    })();""")
    page = context.new_page()
    page.set_default_timeout(15_000)
    errors, checks = [], {}
    page.on('pageerror', lambda error: errors.append(str(error)))
    name = f'improvements-{engine}-{width}'
    result = {'engine': engine, 'browserVersion': browser.version, 'mobile': mobile,
              'viewport': {'width': width, 'height': height}, 'checks': checks}
    try:
        page.goto(f"{manifest['baseUrl']}/session/{SESSION}", wait_until='domcontentloaded')
        check_excerpt(page, mobile, evidence, name, checks)
        check_pins(page, mobile, manifest, evidence, name, checks)
        check_diagnostics(page, mobile, evidence, name, checks)
        check_attention(page, mobile, checks)
        check_reconnect(page, checks)
        check_terminal_accessibility(page, mobile, evidence, name, checks)
        assert not errors, errors
        checks['no_page_errors'] = True
        result['ok'] = True
    except Exception as error:
        result.update(ok=False, error=str(error), pageErrors=errors)
        page.screenshot(path=str(evidence / f'{name}-failure.png'))
    finally:
        context.close()
    print(json.dumps({'engine': engine, 'width': width, 'ok': result['ok'],
                      'checks': list(checks), 'error': result.get('error', '').split('\n')[0]}), flush=True)
    return result


def main():
    manifest = json.loads((ROOT / '.omo/cua/current.json').read_text())
    evidence = Path(os.environ.get('CUA_EVIDENCE_DIR', manifest['evidenceRoot']))
    evidence.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as playwright:
        chrome = playwright.chromium.connect_over_cdp(os.environ.get('CUA_CDP_URL', 'http://127.0.0.1:9333'))
        results.append(run_case(chrome, 'chromium', 1440, 1000, False, manifest, evidence))
        for width, height in ((320, 568), (390, 844)):
            results.append(run_case(chrome, 'chromium', width, height, True, manifest, evidence))
        if os.environ.get('CUA_MOBILE_WEBKIT') == '1':
            webkit = playwright.webkit.launch()
            try:
                for width, height in ((320, 568), (390, 844)):
                    results.append(run_case(webkit, 'webkit', width, height, True, manifest, evidence))
            finally:
                webkit.close()
    report = {'ok': all(result['ok'] for result in results),
              'capturedAt': datetime.now(timezone.utc).isoformat(),
              'mode': 'desktop_and_mobile_browser_emulation', 'cases': results}
    (evidence / 'improvement-interactions.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

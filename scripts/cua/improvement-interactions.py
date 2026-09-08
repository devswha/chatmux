#!/usr/bin/env python3
"""Exercise additive settings/navigation features in the owned CUA fixture.

Uses disposable browser contexts and synthetic transcripts. Clipboard writes are
captured inside the test page; nothing reaches the operator's clipboard or agents.
Mobile cases are browser emulation, not physical phone/screen-reader evidence.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import sys
import traceback

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


def open_sidebar(page, mobile, close_name='Close sidebar'):
    if not mobile:
        return
    close = page.get_by_role('button', name=close_name, exact=True)
    # Computed visibility stays true during a closing transition. Inspect the
    # requested state, then wait for the opening panel to reach the viewport.
    requested_open = close.count() > 0 and close.evaluate("node => node.parentElement.classList.contains('visible')")
    if not requested_open:
        page.get_by_role('button', name='Open menu', exact=True).tap()
    panel = close.locator('xpath=following-sibling::div[1]')
    expect(panel).to_be_in_viewport(ratio=1)


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


DIAGNOSTIC_PATHS = ('/api/settings/diagnostics', '/api/settings/diagnostics/panes')
PRIVATE_SENTINEL = 'PRIVATE_DIAGNOSTIC_SENTINEL'


def arm_diagnostics(page, refresh_name):
    # Subscribe before the click. Completion is the actual busy -> idle DOM
    # transition, not a response-header event (JSON bodies can still be pending).
    page.evaluate("""name => {
      window.__paneSettled = new Promise((resolve, reject) => {
        let busy = false;
        const observer = new MutationObserver(() => {
          const button = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === name);
          if (button?.disabled) busy = true;
          if (busy && button && !button.disabled) {
            observer.disconnect(); clearTimeout(deadline); resolve(true);
          }
        });
        const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('diagnostics did not settle')); }, 15000);
        observer.observe(document.body, {subtree:true, childList:true, attributes:true});
      });
    }""", refresh_name)


def diagnostic_fields(scope, fields):
    for field, value in fields.items():
        expected = str(value).lower() if isinstance(value, bool) else str(value)
        node = scope.locator(f'[data-diagnostic-field="{field}"]')
        assert node.count() == 1, f'missing/duplicate diagnostic field {field}'
        assert node.get_attribute('data-value') == expected, f'{field}: expected {expected}, got {node.get_attribute("data-value")}'
        assert node.locator('dd').inner_text().strip(), f'{field} has no visible value'


def assert_pane_sample(panes, data, copy):
    assert panes.get_attribute('data-state') == 'ready'
    assert panes.get_attribute('aria-busy') == 'false'
    collector, host, coverage, limits = (data[key] for key in ('collector', 'host', 'coverage', 'limits'))
    diagnostic_fields(panes, {
        'sample-time': data['generatedAtMs'], 'cache-ttl': data['cacheTtlMs'], 'stale-threshold': data['staleAfterMs'],
        'collector-status': collector['status'], 'collector-freshness': collector['freshness'],
        'scan-age': collector['scanAgeMs'] if collector['scanAgeMs'] is not None else 'unknown',
        'full-scan-age': collector['fullScanAgeMs'] if collector['fullScanAgeMs'] is not None else 'unknown',
        'host-age': host['ageMs'] if host['ageMs'] is not None else 'unknown',
        'host-freshness': host['freshness'], 'host-capture': host['capture'], 'host-failure': host['failure'] or 'none',
        'total-rows': coverage['totalRows'] if coverage['totalRows'] is not None else 'unknown',
        'rows-inspected': coverage['rowsInspected'], 'rows-omitted': coverage['rowsOmitted'],
        'invalid-rows-omitted': coverage['invalidRowsOmitted'], 'host-panes-omitted': coverage['hostPanesOmitted'],
        'host-processes-omitted': coverage['hostProcessesOmitted'], 'counts-capped': coverage['countsCapped'],
        'limit-discovery-rows': limits['discoveryRows'], 'limit-host-panes': limits['hostPanes'],
        'limit-host-processes': limits['hostProcesses'], 'limit-lineage-pids': limits['lineagePids'],
    })
    for index, lane in enumerate(('external', 'live')):
        scope = panes.locator('[data-diagnostic-field="lane-status"]').nth(index).locator('xpath=../..')
        value = collector['lanes'][lane]
        diagnostic_fields(scope, {'lane-status': value['status'], 'lane-rows': value['rows'],
                                 'lane-stale-rows': value['staleRows'], 'lane-failures': value['consecutiveFailures']})
    for index, socket in enumerate(host['sockets']):
        scope = panes.locator('[data-diagnostic-field="socket-slot"]').nth(index).locator('xpath=../..')
        diagnostic_fields(scope, {'socket-slot': socket['slot'], 'socket-capture': socket['capture'],
                                 'socket-reason': socket['reason'] or 'none', 'socket-pane-count': socket['paneCount']})
    assert panes.get_by_role('article').count() == len(data['panes'])
    for pane in data['panes']:
        card = panes.get_by_role('article', name=f"Pane {pane['paneNumber']}", exact=True)
        diagnostic_fields(card, {'socket': pane['socketNumber'], 'capture-slot': pane['captureSlot'] or 'unknown',
                                'session': pane['sessionId'], 'window': pane['windowId'], 'pane': pane['paneId'],
                                'pane-pid': pane['panePid'] or 'unknown'})
        assert card.get_by_role('region').count() == len(pane['observations'])
        for observation in pane['observations']:
            region = card.get_by_role('region', name=copy['panes'][observation['lane']], exact=True)
            assert region.get_attribute('data-freshness') == observation['freshness']
            process, binding = observation['process'], observation['binding']
            diagnostic_fields(region, {
                **{key: observation[key] for key in ('provider', 'presence', 'freshness', 'activity')},
                'binding': binding['grade'], 'provider-session': binding['providerSessionReported'],
                'agent-pid': process['agentPid'] or 'unknown', 'generation': process['generation'],
                'lineage': process['lineage']['relation'], 'lineage-reason': process['lineage']['reason'] or 'none',
                'lineage-pids': ','.join(map(str, process['lineage']['pids'])),
                'actionability': observation['actionabilityReport'], 'connection-issue': observation['connectionIssue'] or 'none',
            })
    rendered = panes.locator('[data-diagnostic-field]').evaluate_all("""nodes => nodes.map(node => ({
      name: node.dataset.diagnosticField, value: node.dataset.value, text: node.querySelector('dd').innerText,
      number: new Intl.NumberFormat(localStorage.getItem('userLanguage') || 'en').format(Number(node.dataset.value))
    }))""")
    for field in rendered:
        value = field['value']
        if field['name'] == 'lane-status':
            assert field['text'] == copy['laneStates'][value]
        elif field['name'] == 'lineage-pids':
            assert re.findall(r'\d+', field['text']) == (value.split(',') if value else [])
            if not value:
                assert field['text'] == copy['panes']['values']['unknown']
        elif value in copy['panes']['values']:
            assert field['text'] == copy['panes']['values'][value], f'wrong localized display for {value}'
        elif field['name'] in ('session', 'window', 'pane'):
            assert field['text'] == value
        elif value.isdigit() and field['name'] not in ('sample-time', 'cache-ttl', 'stale-threshold', 'scan-age', 'full-scan-age', 'host-age'):
            assert field['text'] == field['number'], f'wrong displayed number for {field["name"]}'
    assert panes.locator('button, a, input, select, textarea, [role="button"], [role="link"]').count() == 0


def edge_pane_sample(real):
    # Wire-only fixtures: these prove rendering, NOT backend projection/auth.
    sample = json.loads(json.dumps(real))
    sample.update(generatedAtMs=100000, cacheTtlMs=2000, staleAfterMs=30000)
    sample['collector'] = {'status': 'available', 'freshness': 'fresh', 'scanAgeMs': 1000, 'fullScanAgeMs': 8000,
        'lanes': {'external': {'status': 'ok', 'rows': 2, 'staleRows': 0, 'consecutiveFailures': 0},
                  'live': {'status': 'degraded', 'rows': 1, 'staleRows': 1, 'consecutiveFailures': 3}}}
    sample['host'] = {'freshness': 'stale', 'ageMs': 42000, 'capture': 'partial', 'failure': 'capture_failed',
        'sockets': [{'slot': 1, 'capture': 'ok', 'reason': None, 'paneCount': 1},
                    {'slot': 2, 'capture': 'unavailable', 'reason': 'socket_unavailable', 'paneCount': 0}]}
    sample['coverage'] = dict(totalRows=1002, rowsInspected=1000, rowsOmitted=2, invalidRowsOmitted=3,
                              hostPanesOmitted=4, hostProcessesOmitted=5, countsCapped=True)
    pids = list(range(2147483600, 2147483632))
    fresh = dict(lane='external', provider='codex', presence='present', freshness='fresh', activity='waiting_user',
                 connectionIssue=None, actionabilityReport='reported_true',
                 binding=dict(grade='observed', providerSessionReported=True),
                 process=dict(agentPid=pids[-1], generation='recorded', lineage=dict(relation='descendant', reason=None, pids=pids)))
    stale = json.loads(json.dumps(fresh))
    stale.update(lane='live', presence='stale', freshness='stale', activity='error',
                 connectionIssue='transcript_permission_denied', actionabilityReport='reported_false')
    stale['binding'] = dict(grade='inferred', providerSessionReported=False)
    unknown = json.loads(json.dumps(fresh))
    unknown.update(provider='unknown', freshness='unknown', activity='unknown', connectionIssue='unknown', actionabilityReport='unknown')
    unknown['binding'] = dict(grade='unknown', providerSessionReported=False)
    unknown['process'] = dict(agentPid=None, generation='unknown', lineage=dict(relation='unknown', reason='host_unavailable', pids=[]))
    sample['panes'] = [dict(paneNumber=1, socketNumber=1, captureSlot=1, sessionId='$0', windowId='@0', paneId='%0', panePid=pids[0], observations=[fresh, stale]),
                       dict(paneNumber=2, socketNumber=2, captureSlot=None, sessionId='$0', windowId='@0', paneId='%0', panePid=None, observations=[unknown])]
    # Unknown excluded properties deliberately reach the UI boundary, never the
    # persisted response artifacts. A raw-JSON renderer must fail redaction.
    sample['privateKey'] = PRIVATE_SENTINEL
    sample['panes'][0]['socketPath'] = PRIVATE_SENTINEL
    return sample


def check_diagnostics(page, mobile, evidence, name, checks, manifest, language='en'):
    settings = json.loads((ROOT / f'src/i18n/locales/{language}/settings.json').read_text())
    common = json.loads((ROOT / f'src/i18n/locales/{language}/common.json').read_text())
    copy = settings['diagnostics']
    open_sidebar(page, mobile, common['versionUpdate']['ariaLabels']['closeSidebar'])
    activate(page.get_by_role('button', name=settings['title'], exact=True), mobile)
    dialog = page.get_by_role('dialog', name=settings['title'], exact=True)
    refresh = dialog.get_by_role('button', name=copy['refresh'], exact=True)
    panes = dialog.get_by_role('region', name=copy['panes']['title'], exact=True)
    heading = dialog.get_by_role('heading', name=copy['discovery'], exact=True)
    requests, actions = [], []
    page.on('request', lambda request: requests.append(request.url) if request.url.endswith(DIAGNOSTIC_PATHS) else None)

    def settled(action, mount=False):
        before = len(requests)
        arm_diagnostics(page, copy['refresh'])
        action()
        page.evaluate('window.__paneSettled')
        # Vite's real app uses React StrictMode: mount/cleanup/remount starts
        # two pairs, aborting the first. A user refresh must still issue one pair.
        expected_reads = [manifest['baseUrl'] + path for path in DIAGNOSTIC_PATHS] * (2 if mount else 1)
        assert sorted(requests[before:]) == sorted(expected_reads), requests[before:]
        assert PRIVATE_SENTINEL not in page.content(), 'private diagnostic sentinel in DOM'
        # Restrict to Diagnostics content; Settings navigation is not an action.
        content = refresh.locator('xpath=../..')
        assert content.locator('button, a, [role="button"], [role="link"]').count() == 1
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')

    def refresh_sample(label):
        refresh.scroll_into_view_if_needed()
        refresh.focus()
        settled(lambda: page.keyboard.press('Enter'))
        actions.append({'scenario': label, 'trigger': 'keyboard Enter', 'requests': 2,
                        'paneState': panes.get_attribute('data-state') if panes.count() else None,
                        'aggregatePresent': heading.count() == 1, 'ownerError': dialog.locator('[data-diagnostic-error="owner"]').count() == 1})
        (evidence / f'{name}-pane-actions.json').write_text(json.dumps(actions, indent=2) + '\n')

    with page.expect_response(lambda r: r.url.endswith(DIAGNOSTIC_PATHS[0])) as aggregate_read, \
         page.expect_response(lambda r: r.url.endswith(DIAGNOSTIC_PATHS[1])) as pane_read:
        settled(lambda: activate(dialog.get_by_role('button', name=copy['title'], exact=True), mobile), mount=True)
    responses = (aggregate_read.value, pane_read.value)
    summary, real = (response.json() for response in responses)
    for response, data in zip(responses, (summary, real)):
        assert response.status == 200
        assert response.headers['cache-control'] == 'no-store'
        assert 'application/json' in response.headers['content-type']
        assert data['schemaVersion'] == 1
        serialized = json.dumps(data)
        for field in ('socketPath', 'transcriptPath', 'attachCapability', 'commandLine', 'privateKey', 'tmuxName',
                      'projectPath', 'startedAtMs', 'transcriptSessionId', 'providerSessionId', 'inventoryKey',
                      'cwd', 'argv', 'comm', 'credential', 'capability', 'exception', PRIVATE_SENTINEL):
            assert field not in serialized, field
    # Independent expectations from fixture seeding, not a projection of the
    # diagnostics output. Exact local coordinates/PIDs exclude peer collisions.
    local = manifest['api']['external']['data']['externalSessions'] + manifest['api']['live']['data']['liveSessions']
    expected = {(row['tmux']['sessionId'], row['tmux']['windowId'], row['tmux']['paneId']) for row in local}
    actual = {(row['sessionId'], row['windowId'], row['paneId']) for row in real['panes']}
    assert actual == expected, (actual, expected)
    assert {row['socketNumber'] for row in real['panes']} == {1}
    expected_pids = {row['process']['pid'] for row in local if row.get('process')}
    actual_pids = {obs['process']['agentPid'] for row in real['panes'] for obs in row['observations'] if obs['process']['agentPid']}
    assert actual_pids == expected_pids
    expected_providers = {row['tmux']['paneId']: row['kind'] for row in manifest['api']['external']['data']['externalSessions']}
    expected_providers.update({row['tmux']['paneId']: 'gjc' for row in manifest['api']['live']['data']['liveSessions']})
    assert {row['paneId']: obs['provider'] for row in real['panes'] for obs in row['observations']} == expected_providers
    assert_pane_sample(panes, real, copy)
    assert heading.count() == 1
    (evidence / f'{name}-pane-real.json').write_text(json.dumps({'mode': 'real_unmocked', 'responses': [
        {'path': path, 'status': response.status, 'cacheControl': response.headers['cache-control'], 'data': data}
        for path, response, data in zip(DIAGNOSTIC_PATHS, responses, (summary, real))]}, indent=2) + '\n')
    page.screenshot(path=str(evidence / f'{name}-diagnostics.png'))
    with page.expect_response(lambda r: r.url.endswith(DIAGNOSTIC_PATHS[0])) as refreshed_aggregate, \
         page.expect_response(lambda r: r.url.endswith(DIAGNOSTIC_PATHS[1])) as refreshed_panes:
        refresh_sample('real-unmocked-cached-refresh')
    for response in (refreshed_aggregate.value, refreshed_panes.value):
        assert response.status == 200 and response.headers['cache-control'] == 'no-store'
    assert_pane_sample(panes, refreshed_panes.value.json(), copy)
    checks['diagnostics_owner_projection_and_headers'] = True

    synthetic = edge_pane_sample(real)
    def fulfill_sample(route):
        route.fulfill(json=synthetic, headers={'Cache-Control': 'no-store'})
    page.route('**' + DIAGNOSTIC_PATHS[1], fulfill_sample)
    refresh_sample('synthetic-collision-fresh-stale-unknown')
    assert_pane_sample(panes, synthetic, copy)
    for suffix, target in [('pane-start', panes.get_by_role('heading', name=copy['panes']['title'], exact=True)),
                           ('pane-first-card', panes.get_by_role('article').first.locator('h4')),
                           ('pane-last-card', panes.get_by_role('article').last.locator('dd').last)]:
        target.scroll_into_view_if_needed()
        assert target.bounding_box()['y'] >= 0
        assert target.bounding_box()['y'] + target.bounding_box()['height'] <= page.viewport_size['height'] + 1
        page.screenshot(path=str(evidence / f'{name}-{suffix}.png'))
    # Desktop cards have different heights. The last array entry is reachable,
    # but only the lowest field proves the end of the entire pane section.
    fields = panes.locator('article dd')
    lowest = fields.evaluate_all("nodes => nodes.indexOf(nodes.reduce((a, b) => a.getBoundingClientRect().bottom > b.getBoundingClientRect().bottom ? a : b))")
    end = fields.nth(lowest)
    end.scroll_into_view_if_needed()
    assert end.bounding_box()['y'] + end.bounding_box()['height'] <= page.viewport_size['height'] + 1
    page.screenshot(path=str(evidence / f'{name}-pane-end.png'))
    # A 32-PID field must wrap inside its own card, not merely avoid page overflow.
    chain = panes.get_by_role('article').first.locator('[data-diagnostic-field="lineage-pids"]').first
    assert chain.evaluate('n => n.scrollWidth <= n.clientWidth + 1')
    chain.scroll_into_view_if_needed()
    page.screenshot(path=str(evidence / f'{name}-pane-lineage.png'))
    checks['pane_collision_fields_redaction_and_32_pid_wrap'] = True
    ready = json.loads(json.dumps(synthetic))
    for state in ('empty', 'waiting', 'unavailable'):
        synthetic['panes'] = []
        synthetic['collector']['freshness'] = 'fresh' if state == 'empty' else state
        for lane in synthetic['collector']['lanes'].values():
            lane['status'] = 'ok' if state == 'empty' else ('waiting' if state == 'waiting' else 'failing')
        refresh_sample('synthetic-' + state)
        assert panes.get_attribute('data-state') == state, f'expected {state}'
        assert panes.get_by_role('article').count() == 0
        assert heading.count() == 1
        assert panes.get_by_role('alert').count() == (1 if state == 'unavailable' else 0)
        assert panes.get_by_role('status').count() == (1 if state == 'waiting' else 0)
        state_message = panes.get_by_text(copy['panes'][state], exact=True)
        state_message.scroll_into_view_if_needed()
        assert state_message.bounding_box()['y'] >= 0
        assert state_message.bounding_box()['y'] + state_message.bounding_box()['height'] <= page.viewport_size['height'] + 1
        page.screenshot(path=str(evidence / f'{name}-pane-{state}.png'))
    synthetic = ready
    refresh_sample('synthetic-ready-recovery')
    for endpoint in DIAGNOSTIC_PATHS:
        for fault in (404, 503, 'network', 'json', 'unsupported', 401, 403):
            def fail(route):
                match fault:
                    case 'network': route.abort('failed')
                    case 'json': route.fulfill(status=200, content_type='application/json', body='{')
                    case 'unsupported': route.fulfill(json={'schemaVersion': 2})
                    case 401 | 403 | 404 | 503: route.fulfill(status=fault, json={'error': PRIVATE_SENTINEL})
            page.route('**' + endpoint, fail)
            label = f"synthetic-{'panes' if endpoint.endswith('/panes') else 'aggregate'}-{fault}"
            refresh_sample(label)
            if fault in (401, 403):
                assert dialog.locator('[data-diagnostic-error="owner"]').count() == 1
                assert panes.count() == heading.count() == 0, 'owner denial retained diagnostic data'
            elif endpoint.endswith('/panes'):
                assert panes.get_attribute('data-state') == 'unavailable'
                assert panes.get_by_role('article').count() == 0
                assert panes.get_by_role('alert').count() == 1
                assert heading.count() == 1, 'pane failure discarded aggregate'
            else:
                assert heading.count() == 0
                assert_pane_sample(panes, synthetic, copy)
                assert dialog.get_by_role('alert').count() == 1
            alert = dialog.get_by_role('alert').first
            alert.scroll_into_view_if_needed()
            page.screenshot(path=str(evidence / f'{name}-{label}.png'))
            page.unroute('**' + endpoint, fail)
            refresh_sample(label + '-recovery')
            assert_pane_sample(panes, synthetic, copy)
            assert heading.count() == 1
    page.unroute('**' + DIAGNOSTIC_PATHS[1], fulfill_sample)
    refresh_sample('real-unmocked-final-recovery')
    assert panes.get_attribute('data-state') == 'ready'
    activate(dialog.get_by_role('button', name=common['buttons']['close'], exact=True), mobile)
    expect(dialog).to_have_count(0)
    checks['diagnostics_denial_failure_and_recovery'] = True
    checks['diagnostics_narrow_layout'] = True
    checks['pane_states_and_independent_endpoint_failures'] = True


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


def run_case(browser, engine, width, height, mobile, manifest, evidence, language='en'):
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  is_mobile=mobile, has_touch=mobile, device_scale_factor=1, locale='en-US', service_workers='block')
    context.add_init_script("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text=>{window.__excerptCopied=text;}}})")
    context.add_init_script(f"localStorage.setItem('userLanguage', {json.dumps(language)})")
    if language != 'en':
        context.add_init_script("""window.__composerReady = new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (document.querySelector('textarea')) { observer.disconnect(); clearTimeout(deadline); resolve(true); }
          });
          const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('composer did not mount')); }, 30000);
          observer.observe(document, {childList:true, subtree:true});
        });""")
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
    if language != 'en':
        name += '-' + language
    result = {'engine': engine, 'browserVersion': browser.version, 'mobile': mobile,
              'viewport': {'width': width, 'height': height}, 'checks': checks}
    try:
        page.goto(f"{manifest['baseUrl']}/session/{SESSION}", wait_until='domcontentloaded')
        if language == 'en':
            check_excerpt(page, mobile, evidence, name, checks)
            check_pins(page, mobile, manifest, evidence, name, checks)
        else:
            page.evaluate('window.__composerReady')
        check_diagnostics(page, mobile, evidence, name, checks, manifest, language)
        if language == 'en':
            check_attention(page, mobile, checks)
            check_reconnect(page, checks)
            check_terminal_accessibility(page, mobile, evidence, name, checks)
        assert not errors, errors
        checks['no_page_errors'] = True
        result['ok'] = True
    except Exception as error:
        result.update(ok=False, error=str(error), pageErrors=errors, traceback=traceback.format_exc())
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
    results, korean_results = [], []
    with sync_playwright() as playwright:
        chrome = playwright.chromium.connect_over_cdp(os.environ.get('CUA_CDP_URL', 'http://127.0.0.1:9333'))
        results.append(run_case(chrome, 'chromium', 1440, 1000, False, manifest, evidence))
        for width, height in ((320, 568), (390, 844)):
            results.append(run_case(chrome, 'chromium', width, height, True, manifest, evidence))
        for width, height in ((1440, 1000), (320, 568), (390, 844)):
            korean_results.append(run_case(chrome, 'chromium', width, height, width < 500, manifest, evidence, 'ko'))
        if os.environ.get('CUA_MOBILE_WEBKIT') == '1':
            webkit = playwright.webkit.launch()
            try:
                for width, height in ((320, 568), (390, 844)):
                    results.append(run_case(webkit, 'webkit', width, height, True, manifest, evidence))
            finally:
                webkit.close()
    report = {'ok': all(result['ok'] for result in results + korean_results),
              'capturedAt': datetime.now(timezone.utc).isoformat(),
              'mode': 'desktop_and_mobile_browser_emulation', 'cases': results,
              'koreanDiagnosticsCases': korean_results}
    (evidence / 'improvement-interactions.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

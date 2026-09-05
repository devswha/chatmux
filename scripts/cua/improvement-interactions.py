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


def run_case(browser, engine, width, height, mobile, manifest, evidence):
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
    context.add_init_script("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text=>{window.__excerptCopied=text;}}})")
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
        assert not errors, errors
        checks['no_page_errors'] = True
        result['ok'] = True
    except Exception as error:
        result.update(ok=False, error=str(error), pageErrors=errors)
        page.screenshot(path=str(evidence / f'{name}-failure.png'))
    finally:
        context.close()
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

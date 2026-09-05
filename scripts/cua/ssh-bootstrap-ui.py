#!/usr/bin/env python3
"""Test the real SSH enrollment components with simulated responses in a disposable browser.

Start Vite first. This fixture opens no SSH connections and does not install software.
Mobile dimensions are browser emulation, not physical device or release-grade CUA evidence.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:4341')
    parser.add_argument('--evidence-dir', default='.omo/evidence/ssh-bootstrap')
    args = parser.parse_args()
    parsed = urlparse(args.base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        parser.error('--base-url must name the local Vite origin')
    evidence = Path(args.evidence_dir).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    cases = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for language, width, height, name in [('en', 1280, 900, 'desktop'), ('en', 390, 844, 'mobile-en'), ('ko', 320, 844, 'mobile-ko')]:
                context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
                try:
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(f'{args.base_url.rstrip("/")}/scripts/cua/ssh-bootstrap-fixture.html?lang={language}')
                    expect(page.get_by_text('Local UI fixture', exact=False)).to_be_visible()
                    form = page.locator('form')
                    form.locator('select').select_option('ssh-easy')
                    picker = page.locator('[name=sshCandidate]')
                    picker.select_option('100.64.0.9')
                    expect(page.locator('[name=sshTarget]')).to_have_value('demo@100.64.0.9')
                    expect(page.locator('[name=label]')).to_have_value('lab-linux')
                    toggle = page.locator('[name=installCli]')
                    expect(toggle).not_to_be_checked()
                    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), name
                    page.screenshot(path=str(evidence / f'{name}.png'), full_page=True)
                    for scenario in ['success', 'missing', 'unsupported', 'failed', 'network']:
                        page.locator('#scenario').select_option(scenario)
                        toggle.set_checked(scenario == 'success')
                        page.locator('[name=password]').fill('fixture-only')
                        form.locator('[type=submit]').click()
                        expect(page.locator('[name=password]')).to_have_value('')
                        expect(form.locator('[type=submit]')).to_be_disabled()
                        recorded = json.loads(page.locator('#fixture-result').inner_text())
                        assert recorded['installCli'] == (scenario == 'success')
                        if scenario == 'success':
                            expect(form.locator('[role=status]')).to_contain_text('8022')
                        else:
                            expect(form.locator('[role=alert]')).to_be_visible()
                            if scenario == 'missing':
                                expect(form.locator('code')).to_contain_text('--port 3001')
                            else:
                                expect(form.locator('code')).to_have_count(0)
                        assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), (name, scenario)
                    picker.select_option('100.64.0.8')
                    expect(page.locator('[name=sshTarget]')).to_have_value('demo@100.64.0.8')
                    expect(page.locator('[name=label]')).to_have_value('lab-linux')
                    expect(picker.locator('..')).to_contain_text('macOS')
                    assert not errors, errors
                    cases.append({'case': name, 'language': language, 'viewport': [width, height], 'scenarios': 5, 'result': 'passed'})
                finally:
                    context.close()
        finally:
            browser.close()
    report = {'scope': 'simulated SSH UI; no remote operations', 'cases': cases}
    (evidence / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()

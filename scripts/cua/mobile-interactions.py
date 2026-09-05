#!/usr/bin/env python3
"""Touch, rotation, short-viewport, and live-send checks in the owned CUA fixture.

Chrome runs through the existing disposable CDP browser. Set CUA_MOBILE_WEBKIT=1
to also run WebKit (install its Playwright browser first). These are browser
emulations; they do not claim physical iOS/Android keyboard or OS coverage.
"""

import json
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import uuid

try:
    from playwright.sync_api import expect, sync_playwright
except ModuleNotFoundError:
    fallback = "/usr/bin/python3.10"
    if os.environ.get("CUA_PY_FALLBACK") != "1" and os.path.isfile(fallback):
        os.environ["CUA_PY_FALLBACK"] = "1"
        os.execv(fallback, [fallback, __file__, *sys.argv[1:]])
    raise


ROOT = Path(__file__).resolve().parents[2]
SESSION = "019f0000-0000-7000-8000-000000000103"
LAYOUT = """() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
  };
  return {
    width: innerWidth, height: innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    composer: box('form'), input: box('textarea'),
  };
}"""


def check_layout(page, name, checks):
    page.wait_for_function("""() => {
      const r = document.querySelector('form')?.getBoundingClientRect();
      return r && r.left >= 0 && r.right <= innerWidth + 1
        && r.top >= 0 && r.bottom <= innerHeight + 1;
    }""", timeout=10_000)
    result = page.evaluate(LAYOUT)
    assert not result["horizontalOverflow"], result
    assert result["input"]["height"] <= min(480, result["height"] * 0.5) + 2, result
    checks[name] = result


def touch_resize(page):
    handle = page.get_by_role("separator")
    # Clearing a long draft moves the handle. Resolve an actionable, stable touch
    # target before sending coordinates through CDP, without forcing the action.
    handle.tap(trial=True)
    box = handle.bounding_box()
    before = page.locator("textarea").bounding_box()["height"]
    session = page.context.new_cdp_session(page)
    try:
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for distance in (25, 50, 100):
            session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - distance}]})
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_function("before => document.querySelector('textarea').getBoundingClientRect().height > before + 40", arg=before)
        return {"before": before, "after": page.locator("textarea").bounding_box()["height"]}
    finally:
        session.detach()


def run_case(browser, engine, width, height, manifest, evidence):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=True, has_touch=True, device_scale_factor=1,
    )
    page = context.new_page()
    page.set_default_timeout(15_000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    checks = {}
    result = {"engine": engine, "viewport": {"width": width, "height": height}, "checks": checks}
    try:
        page.goto(f"{manifest['baseUrl']}/session/{SESSION}", wait_until="domcontentloaded")
        composer = page.locator("textarea")
        expect(composer).to_be_visible(timeout=30_000)
        composer.fill("한글 입력과 줄바꿈 🧪\n" * 12)
        check_layout(page, "multiline_composer", checks)

        effort = page.get_by_role("button", name="Select reasoning effort", exact=True)
        effort.tap()
        expect(page.get_by_role("menu")).to_be_visible()
        page.get_by_role("menuitemradio", name="low", exact=True).tap()
        expect(page.get_by_role("menu")).to_have_count(0)
        expect(effort).to_contain_text("low")
        effort.tap()
        page.get_by_role("menuitemradio", name="Default", exact=True).tap()
        expect(page.get_by_role("menu")).to_have_count(0)
        checks["touch_effort_menu"] = True

        composer.fill("")
        page.get_by_role("button", name="Show all commands", exact=True).tap()
        menu = page.get_by_role("listbox", name="Available commands")
        expect(menu).to_be_visible()
        menu_box = menu.bounding_box()
        assert menu_box["x"] >= 0 and menu_box["x"] + menu_box["width"] <= width + 1, menu_box
        composer.tap()
        composer.press("Escape")
        expect(menu).to_have_count(0)
        checks["touch_command_menu"] = True

        rotation_draft = "회전 중에도 입력창이 화면 안에 있어야 합니다 🧪\n" * 12
        composer.fill(rotation_draft)
        page.set_viewport_size({"width": 844, "height": 390})
        expect(composer).to_have_value(rotation_draft)
        check_layout(page, "landscape_rotation", checks)
        page.set_viewport_size({"width": width, "height": 340})
        expect(composer).to_have_value(rotation_draft)
        check_layout(page, "short_viewport", checks)
        page.set_viewport_size({"width": width, "height": height})
        expect(composer).to_have_value(rotation_draft)
        check_layout(page, "portrait_restored", checks)
        composer.fill("")
        if engine == "chromium":
            checks["touch_drag_resize"] = touch_resize(page)

        # Only the seeded live Codex pane may receive the synthetic message.
        page.get_by_role("button", name="Open menu", exact=True).tap()
        row = page.get_by_text("cua-03-codex", exact=True).first
        row.locator("xpath=ancestor::button[1]").tap()
        expect(page.get_by_role("tab", name="CLI output", exact=True)).to_be_visible()
        expect(page.locator("textarea")).to_have_attribute("placeholder", "Message cua-03-codex…")
        marker = f"mobile-{engine}-{width}-{uuid.uuid4().hex[:8]} 한글 🧪"
        before = {agent["kind"]: Path(agent["logPath"]).read_text() for agent in manifest["agents"]}
        page.locator("textarea").fill(marker)
        page.locator("form").get_by_role("button", name="Send", exact=True).tap()
        expect(page.get_by_text(marker, exact=True).first).to_be_visible(timeout=20_000)
        expect(page.locator("textarea")).to_have_value("")
        for agent in manifest["agents"]:
            delta = Path(agent["logPath"]).read_text()[len(before[agent["kind"]]):]
            assert (marker in delta) == (agent["kind"] == "codex"), agent["kind"]
        checks["touch_live_send_and_pane_isolation"] = True
        check_layout(page, "live_composer", checks)
        page.screenshot(path=str(evidence / f"mobile-{engine}-{width}-chat.png"))

        page.get_by_role("tab", name="CLI output", exact=True).tap()
        expect(page.locator(".xterm-screen")).to_be_visible(timeout=15_000)
        page.get_by_role("tab", name="Chat", exact=True).tap()
        expect(page.locator("textarea")).to_be_visible()
        checks["touch_chat_terminal_roundtrip"] = True
        assert not errors, errors
        result["ok"] = True
    except Exception as error:
        result.update(ok=False, error=str(error), pageErrors=errors, layout=page.evaluate(LAYOUT))
        page.screenshot(path=str(evidence / f"mobile-{engine}-{width}-failure.png"))
    finally:
        context.close()
    return result


def main():
    manifest = json.loads((ROOT / ".omo/cua/current.json").read_text())
    evidence = Path(os.environ.get("CUA_EVIDENCE_DIR", manifest["evidenceRoot"]))
    evidence.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as playwright:
        chrome = playwright.chromium.connect_over_cdp(os.environ.get("CUA_CDP_URL", "http://127.0.0.1:9333"))
        engines = [("chromium", chrome)]
        if os.environ.get("CUA_MOBILE_WEBKIT") == "1":
            engines.append(("webkit", playwright.webkit.launch()))
        try:
            for engine, browser in engines:
                for width, height in ((320, 568), (390, 844)):
                    result = run_case(browser, engine, width, height, manifest, evidence)
                    results.append(result)
                    print(json.dumps({"engine": engine, "width": width, "ok": result["ok"], "checks": list(result["checks"]), "error": result.get("error")}), flush=True)
        finally:
            for engine, browser in engines:
                if engine == "webkit":
                    browser.close()
    report = {"ok": all(result["ok"] for result in results), "capturedAt": datetime.now(timezone.utc).isoformat(), "mode": "mobile_browser_emulation", "cases": results}
    (evidence / "mobile-interactions.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

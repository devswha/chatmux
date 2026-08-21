#!/usr/bin/env python3

import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any

from playwright.sync_api import sync_playwright


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CURRENT_PATH = REPOSITORY_ROOT / ".omo" / "cua" / "current.json"
SESSION_ID = "019f0000-0000-7000-8000-000000000106"
LONG_TURN_PROMPT = "__fake_long_running_turn__"
CREATED_SESSION = "cua-created-codex"
ORDER_STORAGE_KEY = "chatmux.liveSessionOrder.v1"


def read_events(log_path: str) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in Path(log_path).read_text(encoding="utf-8").splitlines()
        if line
    ]


def wait_for_event(log_path: str, event_type: str, timeout_seconds: float = 10) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if any(event.get("type") == event_type for event in read_events(log_path)):
            return True
        time.sleep(0.1)
    return False


def capture_pane(manifest: dict[str, Any], session_name: str) -> str:
    environment = dict(os.environ)
    environment.pop("TMUX", None)
    environment["HOME"] = str(Path(manifest["harnessRoot"]) / "home")
    environment["TMUX_TMPDIR"] = str(Path(manifest["harnessRoot"]) / "sockets")
    return subprocess.run(
        ["tmux", "capture-pane", "-p", "-S", "-", "-t", f"={session_name}:"],
        check=True,
        capture_output=True,
        env=environment,
        text=True,
    ).stdout


manifest = json.loads(CURRENT_PATH.read_text(encoding="utf-8"))
evidence_root = Path(manifest["evidenceRoot"])
cdp_url = os.environ.get("CUA_CDP_URL", "http://127.0.0.1:9333")
session_url = f"{manifest['baseUrl']}/session/{SESSION_ID}"
gjc_agent = next(agent for agent in manifest["agents"] if agent["kind"] == "gjc")
results: dict[str, Any] = {
    "mode": "browser_cdp_fallback",
    "sessionUrl": session_url,
    "checks": {},
    "artifacts": {},
}

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(cdp_url)
    context = browser.contexts[0]
    page = context.new_page()
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(session_url, wait_until="domcontentloaded")
    gjc_row = page.get_by_text("cua-06-gjc", exact=True).first
    gjc_row.wait_for(timeout=15_000)
    gjc_row.locator("xpath=ancestor::button[1]").click()
    page.get_by_role("tab", name="Chat", exact=True).wait_for(timeout=15_000)

    page.get_by_role("button", name="New session", exact=True).click()
    page.get_by_role("button", name="Codex", exact=True).click()
    page.get_by_placeholder("Session name (letters and numbers, e.g. my-feature)").fill(CREATED_SESSION)
    page.get_by_placeholder(
        "Working folder (e.g. ~/workspace/my-proj or an absolute path)"
    ).fill(str(Path(manifest["harnessRoot"]) / "home"))
    page.get_by_role("button", name="Create", exact=True).click()
    page.get_by_text(CREATED_SESSION, exact=True).first.wait_for(timeout=15_000)
    results["checks"]["session_created"] = {
        "ok": page.get_by_text(CREATED_SESSION, exact=True).count() > 0,
        "session": CREATED_SESSION,
    }
    created_pane = capture_pane(manifest, CREATED_SESSION)
    spawned_log_dir = Path(manifest["harnessRoot"]) / "home" / ".chatmux-cua-spawned"
    spawned_logs = list(spawned_log_dir.glob("codex-*.ndjson"))
    results["checks"]["isolated_fake_spawn"] = {
        "ok": (
            "ChatMux CUA fixture ready: codex" in created_pane
            and len(spawned_logs) == 1
        ),
        "spawnedLogs": [str(path) for path in spawned_logs],
    }

    order_before = page.evaluate(f"localStorage.getItem('{ORDER_STORAGE_KEY}')")
    drag_handle = page.get_by_role(
        "button",
        name="Drag to reorder session 'cua-07-omp'",
        exact=True,
    )
    drag_handle.focus()
    page.keyboard.press("Space")
    page.wait_for_timeout(300)
    page.keyboard.press("ArrowUp")
    page.wait_for_timeout(200)
    page.keyboard.press("ArrowUp")
    page.wait_for_timeout(200)
    page.keyboard.press("Space")
    page.wait_for_timeout(300)
    order_after = page.evaluate(f"localStorage.getItem('{ORDER_STORAGE_KEY}')")
    results["checks"]["session_reordered"] = {
        "ok": bool(order_after and order_after != order_before),
        "before": json.loads(order_before) if order_before else [],
        "after": json.loads(order_after) if order_after else [],
    }

    composer = page.locator("textarea")
    composer.fill(LONG_TURN_PROMPT)
    composer.press("Enter")
    page.get_by_role("button", name="Stop", exact=True).wait_for(timeout=10_000)
    page.get_by_role("button", name="Stop", exact=True).click()
    interrupted = wait_for_event(gjc_agent["logPath"], "turn_interrupted")
    results["checks"]["interrupt"] = {
        "ok": interrupted,
        "prompt": LONG_TURN_PROMPT,
    }

    transcript_path = Path(manifest["gjcTranscriptPath"])
    with transcript_path.open("a", encoding="utf-8") as transcript:
        transcript.write(json.dumps({
            "type": "error",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error": {"message": "Synthetic CUA validation error"},
        }) + "\n")
        transcript.flush()
        os.fsync(transcript.fileno())
    error_badge = page.get_by_text("ERROR", exact=True).first
    error_badge.wait_for(timeout=15_000)
    results["checks"]["error_state"] = {"ok": error_badge.is_visible()}
    page.screenshot(path=evidence_root / "desktop-interactions.png")
    results["artifacts"]["desktop_interactions"] = str(
        evidence_root / "desktop-interactions.png"
    )

    created_row = page.get_by_text(CREATED_SESSION, exact=True).first
    created_row.locator("xpath=ancestor::button[1]").click()
    pending_heading = page.get_by_text("Codex transcript pending", exact=True)
    pending_heading.wait_for(timeout=15_000)
    switch_screenshot = evidence_root / "desktop-session-switch.png"
    page.screenshot(path=switch_screenshot)
    results["checks"]["session_switched"] = {
        "ok": pending_heading.is_visible(),
        "session": CREATED_SESSION,
    }
    results["artifacts"]["desktop_session_switch"] = str(switch_screenshot)

results["ok"] = all(check["ok"] for check in results["checks"].values())
report_path = evidence_root / "ui-interactions.json"
report_path.write_text(
    f"{json.dumps(results, indent=2, ensure_ascii=False)}\n",
    encoding="utf-8",
)
print(json.dumps({
    "ok": results["ok"],
    "report": str(report_path),
    "checks": {
        name: check["ok"]
        for name, check in results["checks"].items()
    },
}, indent=2))

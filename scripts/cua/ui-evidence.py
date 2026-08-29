#!/usr/bin/env python3

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

try:
    from playwright.sync_api import Page, sync_playwright
except ModuleNotFoundError:
    fallback = "/usr/bin/python3.10"
    if os.environ.get("CUA_PY_FALLBACK") != "1" and os.path.isfile(fallback):
        os.environ["CUA_PY_FALLBACK"] = "1"
        os.execv(fallback, [fallback, __file__, *sys.argv[1:]])
    raise

from fleet_ui_evidence import run_fleet_scenarios


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CURRENT_PATH = REPOSITORY_ROOT / ".omo" / "cua" / "current.json"
SESSION_ID = "019f0000-0000-7000-8000-000000000103"
PRIMARY_AGENT_KIND = "codex"
PRIMARY_TMUX_NAME = "cua-03-codex"
PROMPT = "Explain how ChatMux keeps this message isolated to one tmux pane."
VIEWPORT_SESSIONS: list[Any] = []

AGENTS = [
    "Oh My OpenAgent",
    "Claude Code",
    "Codex CLI",
    "Cursor",
    "OpenCode",
    "Gajae Code",
    "Oh My Pi",
]


def set_viewport(page: Page, width: int, height: int) -> None:
    session = page.context.new_cdp_session(page)
    session.send("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": width < 640,
    })
    VIEWPORT_SESSIONS.append(session)


def capture_cdp(
    page: Page,
    output_path: Path,
    image_format: str = "png",
) -> None:
    session = page.context.new_cdp_session(page)
    parameters: dict[str, Any] = {
        "format": image_format,
        "fromSurface": True,
    }
    if image_format == "jpeg":
        parameters["quality"] = 80
    result = session.send(
        "Page.captureScreenshot",
        parameters,
    )
    output_path.write_bytes(base64.b64decode(result["data"]))
    session.detach()


def pane_capture(manifest: dict[str, Any]) -> str:
    socket_path = manifest["fleet"]["hub"]["socketPath"]
    return subprocess.run(
        ["tmux", "-S", socket_path, "capture-pane", "-p", "-S", "-", "-t", f"={PRIMARY_TMUX_NAME}:"],
        check=True,
        capture_output=True,
        env={key: value for key, value in os.environ.items() if key not in {"TMUX", "TMUX_PANE"}},
        text=True,
    ).stdout.rstrip()


def capture_x11_window(output_path: Path) -> None:
    environment = dict(os.environ)
    environment.setdefault("DISPLAY", ":0")
    environment.setdefault("XAUTHORITY", "/run/user/1000/gdm/Xauthority")
    tree = subprocess.run(
        ["xwininfo", "-root", "-tree"],
        check=True,
        capture_output=True,
        env=environment,
        text=True,
    ).stdout
    match = re.search(
        r'^\s*(0x[0-9a-f]+)\s+"ChatMux - Google Chrome"',
        tree,
        re.MULTILINE | re.IGNORECASE,
    )
    if not match:
        raise RuntimeError("The dedicated ChatMux Chrome window was not found.")
    raw_path = output_path.with_suffix(".xwd")
    subprocess.run(
        ["xwd", "-silent", "-id", match.group(1), "-out", str(raw_path)],
        check=True,
        env=environment,
    )
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(raw_path),
                str(output_path),
            ],
            check=True,
        )
    finally:
        raw_path.unlink(missing_ok=True)


def input_events(manifest: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for agent in manifest["agents"]:
        events = [
            json.loads(line)
            for line in Path(agent["logPath"]).read_text(encoding="utf-8").splitlines()
            if line
        ]
        result[agent["kind"]] = [
            event["value"]
            for event in events
            if event.get("type") == "input"
        ]
    return result


def sidebar_order_and_status(page: Page, manifest: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for agent in manifest["agents"]:
        label = page.get_by_text(agent["tmuxName"], exact=True).first
        button = label.locator("xpath=ancestor::button[1]")
        box = button.bounding_box()
        text = button.inner_text()
        status = "RUN" if "RUN" in text else "READY" if "READY" in text else None
        rows.append({
            "tmuxName": agent["tmuxName"],
            "status": status,
            "y": box["y"] if box else float("inf"),
        })
    rows.sort(key=lambda row: row["y"])
    actual_order = [row["tmuxName"] for row in rows]
    seeded_gjc = [agent["tmuxName"] for agent in manifest["agents"] if agent["kind"] == "gjc"]
    expected_order = seeded_gjc + [
        agent["tmuxName"] for agent in manifest["agents"] if agent["kind"] != "gjc"
    ]
    expected_statuses = {agent["tmuxName"]: "READY" for agent in manifest["agents"]}
    actual_statuses = {row["tmuxName"]: row["status"] for row in rows}
    return {
        "ok": actual_order == expected_order and actual_statuses == expected_statuses,
        "expectedOrder": expected_order,
        "actualOrder": actual_order,
        "expectedStatuses": expected_statuses,
        "actualStatuses": actual_statuses,
    }


def select_primary_session(page: Page, mobile: bool = False) -> None:
    page.locator("body").wait_for(timeout=15_000)
    row = page.get_by_text(PRIMARY_TMUX_NAME, exact=True).first
    if mobile and not row.is_visible():
        menu = page.locator('button[aria-label="Open menu"], button[aria-label="Open sidebar"]')
        if menu.is_visible():
            menu.click()
        else:
            page.mouse.click(28, 24)
    row.wait_for(timeout=15_000)
    row.locator("xpath=ancestor::button[1]").click()


manifest = json.loads(CURRENT_PATH.read_text(encoding="utf-8"))
evidence_root = Path(manifest["evidenceRoot"])
evidence_root.mkdir(parents=True, exist_ok=True)
events_before_browser = input_events(manifest)
cdp_url = os.environ.get("CUA_CDP_URL", "http://127.0.0.1:9333")
session_url = f"{manifest['baseUrl']}/session/{SESSION_ID}"
results: dict[str, Any] = {
    "mode": "browser_cdp_fallback",
    "reason": (
        "Browser layout and interaction evidence is captured over CDP; native "
        "desktop window-targeting evidence is recorded separately by the "
        "Computer Use MCP harness."
    ),
    "baseUrl": manifest["baseUrl"],
    "sessionUrl": session_url,
    "prompt": PROMPT,
    "checks": {},
    "artifacts": {},
}

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(cdp_url)
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.new_page()
    set_viewport(page, 1600, 1000)
    page.goto(manifest["baseUrl"], wait_until="domcontentloaded")
    page.goto(session_url, wait_until="domcontentloaded")
    select_primary_session(page)
    page.get_by_role("tab", name="Chat", exact=True).wait_for(timeout=15_000)
    page.get_by_text(
        "Give a concise status update for the ChatMux validation run.",
        exact=True,
    ).first.wait_for(timeout=15_000)

    body_text = page.locator("body").inner_text()
    missing_agents = [
        name
        for name in AGENTS
        if name not in body_text
        and page.locator(f"img[alt='{name}']").count() == 0
    ]
    results["checks"]["all_agents_visible"] = {
        "ok": not missing_agents,
        "expected": AGENTS,
        "missing": missing_agents,
    }
    results["checks"]["agent_order_and_status"] = sidebar_order_and_status(
        page,
        manifest,
    )

    composer = page.locator("textarea")
    prompt_message = page.locator("div[dir='auto']").filter(has_text=PROMPT)
    if PROMPT not in events_before_browser[PRIMARY_AGENT_KIND]:
        composer.fill(PROMPT)
        composer.press("Enter")
    else:
        composer.fill("")
    prompt_message.first.wait_for(timeout=15_000)
    page.get_by_text("fake reply 2", exact=True).wait_for(timeout=15_000)
    capture_cdp(page, evidence_root / "desktop-chat.png")
    results["artifacts"]["desktop_chat"] = str(evidence_root / "desktop-chat.png")

    desktop_layout = page.evaluate(
        """() => {
          const textarea = document.querySelector('textarea');
          const box = textarea?.getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight },
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            composerVisible: Boolean(box && box.top >= 0 && box.bottom <= innerHeight),
          };
        }"""
    )
    results["checks"]["desktop_layout"] = {
        "ok": (
            not desktop_layout["horizontalOverflow"]
            and desktop_layout["composerVisible"]
        ),
        **desktop_layout,
    }

    cli_tab = page.get_by_role("tab", name="CLI output", exact=True)
    cli_tab.evaluate("(element) => element.click()")
    page.locator(".xterm-screen").wait_for(timeout=15_000)
    cli_screenshot = evidence_root / "desktop-cli.png"
    try:
        subprocess.run(
            [
                "node",
                str(REPOSITORY_ROOT / "scripts" / "cua" / "cdp-screenshot.mjs"),
                cdp_url,
                str(cli_screenshot),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=45,
        )
        results["artifacts"]["desktop_cli_capture"] = "cdp_surface"
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        capture_x11_window(cli_screenshot)
        results["artifacts"]["desktop_cli_capture"] = "x11_window_fallback"
        results["artifacts"]["desktop_cli_capture_error"] = (
            error.stderr.strip()
            if isinstance(error, subprocess.CalledProcessError) and error.stderr
            else str(error)
        )
    results["artifacts"]["desktop_cli"] = str(cli_screenshot)

    page = context.new_page()
    set_viewport(page, 390, 844)
    page.goto(session_url, wait_until="domcontentloaded")
    select_primary_session(page, mobile=True)
    page.get_by_role("tab", name="Chat", exact=True).wait_for(timeout=15_000)
    page.get_by_text(
        "Give a concise status update for the ChatMux validation run.",
        exact=True,
    ).first.wait_for(timeout=15_000)
    capture_cdp(page, evidence_root / "mobile-chat.png")
    results["artifacts"]["mobile_chat"] = str(evidence_root / "mobile-chat.png")

    mobile_layout = page.evaluate(
        """() => {
          const textarea = document.querySelector('textarea');
          const box = textarea?.getBoundingClientRect();
          const tabs = [...document.querySelectorAll('[role="tab"]')]
            .map((node) => ({ text: node.textContent?.trim(), box: node.getBoundingClientRect() }));
          return {
            viewport: { width: innerWidth, height: innerHeight },
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            composerVisible: Boolean(box && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight),
            tabsVisible: tabs.every(({ box }) => box.left >= 0 && box.right <= innerWidth),
          };
        }"""
    )
    results["checks"]["mobile_layout"] = {
        "ok": (
            not mobile_layout["horizontalOverflow"]
            and mobile_layout["composerVisible"]
            and mobile_layout["tabsVisible"]
        ),
        **mobile_layout,
    }

    page.get_by_role("button", name="Open menu").click()
    page.get_by_text(PRIMARY_TMUX_NAME, exact=True).first.wait_for(timeout=15_000)
    capture_cdp(page, evidence_root / "mobile-agents.png")
    results["artifacts"]["mobile_agents"] = str(evidence_root / "mobile-agents.png")
    drawer_text = page.locator("body").inner_text()
    results["checks"]["mobile_drawer_agents"] = {
        "ok": all(
            name in drawer_text
            or page.locator(f"img[alt='{name}']").count() > 0
            for name in AGENTS
        ),
        "expected": AGENTS,
    }

    fleet_results = run_fleet_scenarios(context, manifest, evidence_root)
    results["fleet"] = fleet_results
    for name, check in fleet_results["checks"].items():
        results["checks"][f"fleet_{name}"] = check
    results["artifacts"].update({f"fleet_{name}": value for name, value in fleet_results["artifacts"].items()})

events = input_events(manifest)
expected_inputs = {
    PRIMARY_AGENT_KIND: [
        "Give a concise status update for the ChatMux validation run.",
        PROMPT,
    ],
    "gjc": ["Prepare the deterministic interaction surface."],
}
unexpected_inputs = {
    kind: values
    for kind, values in events.items()
    if kind not in expected_inputs and values
}
results["checks"]["pane_input_isolation"] = {
    "ok": all(events[kind] == values for kind, values in expected_inputs.items()) and not unexpected_inputs,
    "expectedInputs": expected_inputs,
    "inputsByAgent": events,
}

captured_pane = pane_capture(manifest)
(evidence_root / "pane-cua-03-codex.txt").write_text(
    f"{captured_pane}\n",
    encoding="utf-8",
)
results["checks"]["chat_cli_equivalence"] = {
    "ok": PROMPT in captured_pane and "Assistant: fake reply 2" in captured_pane,
    "expectedPrompt": PROMPT,
    "expectedReply": "Assistant: fake reply 2",
}
results["artifacts"]["pane_capture"] = str(evidence_root / "pane-cua-03-codex.txt")
results["ok"] = all(check["ok"] for check in results["checks"].values())

report_path = evidence_root / "ui-scenarios.json"
report_path.write_text(
    f"{json.dumps(results, indent=2, ensure_ascii=False)}\n",
    encoding="utf-8",
)
print(
    json.dumps(
        {
            "ok": results["ok"],
            "report": str(report_path),
            "checks": {
                name: check["ok"]
                for name, check in results["checks"].items()
            },
        },
        indent=2,
    )
)
if not results["ok"]:
    raise SystemExit(1)

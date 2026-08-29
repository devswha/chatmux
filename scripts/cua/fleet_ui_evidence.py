#!/usr/bin/env python3

import json
from pathlib import Path
import re
from typing import Any

from playwright.sync_api import BrowserContext, Page


SIGNAL_TIMEOUT_MS = 20_000
VIEWPORT_SESSIONS: list[Any] = []


def set_viewport(page: Page, width: int, height: int) -> None:
    session = page.context.new_cdp_session(page)
    session.send("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": width < 640,
    })
    VIEWPORT_SESSIONS.append(session)


def install_websocket_probe(context: BrowserContext) -> None:
    context.add_init_script("""
      (() => {
        const Native = window.WebSocket;
        window.__cuaSockets = [];
        window.__cuaFrames = [];
        window.WebSocket = new Proxy(Native, {
          construct(target, args) {
            const socket = new target(...args);
            window.__cuaSockets.push(socket);
            socket.addEventListener('message', (event) => {
              try {
                const frame = JSON.parse(event.data);
                window.__cuaFrames.push({ direction: 'in', url: socket.url, frame });
                window.dispatchEvent(new CustomEvent('cua-ws-frame', { detail: { direction: 'in', url: socket.url, frame } }));
              } catch {}
            });
            const nativeSend = socket.send.bind(socket);
            socket.send = (data) => {
              let frame = null;
              try { frame = JSON.parse(data); } catch {}
              window.__cuaFrames.push({ direction: 'out', url: socket.url, frame });
              window.dispatchEvent(new CustomEvent('cua-ws-frame', { detail: { direction: 'out', url: socket.url, frame } }));
              nativeSend(data);
              if (window.__cuaCloseRemoteChatOnSend && socket.url.endsWith('/remote-chat') && frame?.type === 'chat.send') {
                window.__cuaCloseRemoteChatOnSend = false;
                socket.close();
              }
            };
            return socket;
          }
        });
      })();
    """)


def arm_frame(page: Page, key: str, direction: str, expression: str) -> None:
    page.evaluate("""({ key, direction, expression, timeout }) => {
      window.__cuaSignals ??= {};
      const predicate = new Function('frame', `return (${expression});`);
      window.__cuaSignals[key] = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener('cua-ws-frame', listener); reject(new Error(`Timed out: ${key}`)); }, timeout);
        const listener = (event) => {
          if (event.detail.direction !== direction || !predicate(event.detail.frame)) return;
          clearTimeout(timer); window.removeEventListener('cua-ws-frame', listener); resolve(event.detail);
        };
        window.addEventListener('cua-ws-frame', listener);
      });
    }""", {"key": key, "direction": direction, "expression": expression, "timeout": SIGNAL_TIMEOUT_MS})


def await_signal(page: Page, key: str) -> dict[str, Any]:
    return page.evaluate("key => window.__cuaSignals[key]", key)


def arm_dom(page: Page, key: str, selector: str, expression: str) -> None:
    page.evaluate("""({ key, selector, expression, timeout }) => {
      window.__cuaSignals ??= {};
      const predicate = new Function('node', `return (${expression});`);
      window.__cuaSignals[key] = new Promise((resolve, reject) => {
        const inspect = () => [...document.querySelectorAll(selector)].find(predicate);
        const observer = new MutationObserver(() => { const node = inspect(); if (node) finish(node); });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out: ${key}`)); }, timeout);
        const finish = (node) => { clearTimeout(timer); observer.disconnect(); resolve({ text: node.textContent, html: node.outerHTML }); };
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const existing = inspect(); if (existing) finish(existing);
      });
    }""", {"key": key, "selector": selector, "expression": expression, "timeout": SIGNAL_TIMEOUT_MS})


def ax_tree(page: Page) -> dict[str, Any]:
    session = page.context.new_cdp_session(page)
    try:
        session.send("Accessibility.enable")
        return session.send("Accessibility.getFullAXTree")
    finally:
        session.detach()


def host_rows(page: Page) -> list[dict[str, Any]]:
    rows = page.locator("[data-host-row='true']")
    return [{
        "label": rows.nth(index).get_attribute("aria-label"),
        "disabled": rows.nth(index).is_disabled(),
    } for index in range(rows.count())]


def run_fleet_scenarios(
    context: BrowserContext,
    manifest: dict[str, Any],
    evidence_root: Path,
) -> dict[str, Any]:
    install_websocket_probe(context)
    page = context.new_page()
    set_viewport(page, 1600, 1000)
    page.goto(manifest["baseUrl"], wait_until="domcontentloaded")
    page.locator("[data-host-id]").nth(2).wait_for(timeout=SIGNAL_TIMEOUT_MS)
    peers = manifest["fleet"]["enrollment"]["peers"]
    host_a, host_b = peers[0]["hostId"], peers[1]["hostId"]
    collision = manifest["fleet"]["collision"]
    session_id = collision["appSessionId"]
    groups = page.locator("[data-host-id]")
    rows = host_rows(page)
    result: dict[str, Any] = {"checks": {}, "artifacts": {}}
    labels = [groups.nth(index).get_attribute("aria-label") for index in range(groups.count())]
    result["checks"]["enrollment_and_host_disambiguation"] = {
        "ok": groups.count() == 3 and host_a[:8] in " ".join(labels) and host_b[:8] in " ".join(labels),
        "hostIds": [groups.nth(index).get_attribute("data-host-id") for index in range(groups.count())],
        "labels": labels, "rows": rows,
    }
    page.screenshot(path=evidence_root / "fleet-desktop-host-groups.png", full_page=True)
    (evidence_root / "fleet-desktop-ax.json").write_text(json.dumps(ax_tree(page), indent=2), encoding="utf-8")

    deep_link = f"{manifest['baseUrl']}/hosts/{host_a}/session/{session_id}"
    page.goto(deep_link, wait_until="domcontentloaded")
    page.locator("textarea").first.wait_for(timeout=SIGNAL_TIMEOUT_MS)
    result["checks"]["remote_deep_link"] = {"ok": page.url == deep_link, "url": page.url}
    remote_message = "task-24 remote chat exact host A final"
    with page.expect_response(lambda response: f"/api/hosts/{host_a}/" in response.url and response.url.endswith("/actions"), timeout=SIGNAL_TIMEOUT_MS) as remote_chat:
        page.locator("textarea").first.fill(remote_message)
        page.locator("textarea").first.press("Enter")
    result["checks"]["remote_chat"] = {"ok": remote_chat.value.status == 200, "status": remote_chat.value.status}
    uncertain_message = "task-24 dispatched unknown outcome"
    def unknown_route(route: Any) -> None:
        if uncertain_message in (route.request.post_data or ""):
            route.fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "HOST_COMMAND_OUTCOME_UNKNOWN", "message": "Command outcome unknown; reconcile this host before retrying."}}))
        else:
            route.fallback()
    context.route(re.compile(r"/api/hosts/.*/providers/panes/.*/actions$"), unknown_route)
    arm_dom(page, "unknown", "body", "node.textContent.includes('Command outcome unknown')")
    page.locator("textarea").first.fill(uncertain_message)
    page.locator("textarea").first.press("Enter")
    unknown = await_signal(page, "unknown")
    context.unroute(re.compile(r"/api/hosts/.*/providers/panes/.*/actions$"), unknown_route)
    result["checks"]["unknown_outcome_visible"] = {"ok": "Command outcome unknown" in unknown["text"]}

    page.goto(manifest["baseUrl"], wait_until="domcontentloaded")
    target = page.locator(f"[data-host-id='{host_a}'] [data-host-row='true']:not([disabled])").first
    target.wait_for(timeout=SIGNAL_TIMEOUT_MS)
    target.click()
    page.get_by_text("Codex transcript pending", exact=True).wait_for(timeout=SIGNAL_TIMEOUT_MS)
    pane_message = "task-24 remote pane action host A"
    with page.expect_response(lambda response: f"/api/hosts/{host_a}/" in response.url and response.url.endswith("/actions"), timeout=SIGNAL_TIMEOUT_MS) as action:
        page.locator("textarea").first.fill(pane_message)
        page.locator("textarea").first.press("Enter")
    result["checks"]["remote_pane_action"] = {"ok": action.value.status == 200, "status": action.value.status}
    arm_frame(page, "remote-attach", "out", f"frame?.type === 'init' && frame.mode === 'remote-attach' && frame.target?.hostId === '{host_a}'")
    page.get_by_role("tab", name="CLI output", exact=True).click()
    attach = await_signal(page, "remote-attach")
    result["checks"]["remote_terminal_attach"] = {"ok": attach["frame"]["target"]["hostId"] == host_a}
    page.screenshot(path=evidence_root / "fleet-remote-terminal.png", full_page=True)

    arm_frame(page, "offline", "in", f"frame?.kind === 'fleet.host_state' && frame.host?.hostId === '{host_a}' && frame.host?.state === 'offline'")
    arm_dom(page, "offline-dom", f"[data-host-id='{host_a}']", "node.textContent.includes('Offline')")
    stopped = page.request.post(f"{manifest['control']['url']}/peer-a/stop")
    offline = await_signal(page, "offline")
    await_signal(page, "offline-dom")
    result["checks"]["offline_fail_closed"] = {"ok": stopped.ok and offline["frame"]["host"]["state"] == "offline"}

    arm_frame(page, "syncing", "in", f"frame?.kind === 'fleet.host_state' && frame.host?.hostId === '{host_a}' && frame.host?.state === 'syncing'")
    arm_frame(page, "online", "in", f"frame?.kind === 'fleet.host_state' && frame.host?.hostId === '{host_a}' && frame.host?.state === 'online'")
    arm_frame(page, "snapshot", "in", f"frame?.kind === 'fleet.catalog.snapshot' && frame.hostId === '{host_a}'")
    started = page.request.post(f"{manifest['control']['url']}/peer-a/start")
    syncing = await_signal(page, "syncing")
    await_signal(page, "snapshot")
    online = await_signal(page, "online")
    result["checks"]["resync_and_recovery"] = {"ok": started.ok and syncing["frame"]["host"]["state"] == "syncing" and online["frame"]["host"]["state"] == "online"}

    page.reload(wait_until="domcontentloaded")
    page.locator(f"[data-host-id='{host_a}']").wait_for(timeout=SIGNAL_TIMEOUT_MS)
    actual = page.evaluate("hostId => window.__cuaFrames.map(x => x.frame).findLast(x => x?.kind === 'fleet.host_state' && x.host?.hostId === hostId)", host_a)
    incompatible = {**actual, "host": {**actual["host"], "state": "incompatible", "protocolVersion": None}}
    arm_dom(page, "incompatible-dom", f"[data-host-id='{host_a}']", "node.textContent.includes('Incompatible') && [...node.querySelectorAll('[data-host-row=true]')].every(row => row.disabled)")
    page.evaluate("frame => window.__cuaSockets.find(socket => socket.url.endsWith('/ws'))?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))", incompatible)
    await_signal(page, "incompatible-dom")
    result["checks"]["incompatible_fail_closed"] = {"ok": page.locator(f"[data-host-id='{host_a}'] [data-host-row='true']:not([disabled])").count() == 0}

    notification_href = f"{manifest['baseUrl']}/hosts/{host_a}/session/{session_id}"
    page.goto(notification_href, wait_until="domcontentloaded")
    page.locator("textarea").first.wait_for(timeout=SIGNAL_TIMEOUT_MS)
    result["checks"]["notification_deep_link"] = {"ok": page.url == notification_href, "url": page.url, "source": "host-qualified completion href"}

    page = context.new_page()
    set_viewport(page, 390, 844)
    page.goto(manifest["baseUrl"], wait_until="domcontentloaded")
    page.get_by_role("button", name="Open menu").click()
    page.locator(f"[data-host-id='{host_b}']").wait_for(timeout=SIGNAL_TIMEOUT_MS)
    overflow = page.evaluate("document.documentElement.scrollWidth > innerWidth")
    page.screenshot(path=evidence_root / "fleet-mobile-host-groups.png", full_page=True)
    (evidence_root / "fleet-mobile-ax.json").write_text(json.dumps(ax_tree(page), indent=2), encoding="utf-8")
    result["checks"]["mobile_layout_and_ax"] = {"ok": not overflow and host_b[:8] in page.locator("body").inner_text()}
    result["artifacts"] = {"desktop": "fleet-desktop-host-groups.png", "desktopAx": "fleet-desktop-ax.json", "terminal": "fleet-remote-terminal.png", "mobile": "fleet-mobile-host-groups.png", "mobileAx": "fleet-mobile-ax.json"}
    result["ok"] = all(check["ok"] for check in result["checks"].values())
    (evidence_root / "fleet-ui-scenarios.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result

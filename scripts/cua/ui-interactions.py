#!/usr/bin/env python3

import ctypes
import json
import os
import re
import select
import sys
from pathlib import Path
import subprocess
import threading
import time
from typing import Any


# The CUA fixture harness pre-installs Playwright for python3.10. On hosts
# where the default `python3` resolves to a newer interpreter without the
# Playwright package, re-execute under python3.10 once. This keeps
# `npm run cua:ui:interactions` working regardless of which minor version
# `python3` points at.
try:
    from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright
except ModuleNotFoundError:
    fallback = "/usr/bin/python3.10"
    if os.environ.get("CUA_PY_FALLBACK") != "1" and os.path.isfile(fallback):
        os.environ["CUA_PY_FALLBACK"] = "1"
        os.execv(fallback, [fallback, __file__, *sys.argv[1:]])
    raise


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CURRENT_PATH = REPOSITORY_ROOT / ".omo" / "cua" / "current.json"
SESSION_ID = "019f0000-0000-7000-8000-000000000106"
LONG_TURN_PROMPT = "__fake_long_running_turn__"
CREATED_SESSION = "cua-created-codex"
CREATED_OMO_SESSION = "cua-01-omo"
ORDER_STORAGE_KEY = "chatmux.liveSessionOrder.v2"
SKILLS_URL_RE = re.compile(r"/api/providers/([^/]+)/skills(?:\?|$)")
VIEWPORT_SESSIONS: list[Any] = []


# ─── slash-menu skill fixtures ─────────────────────────────────────────
# Deterministic per-provider skill catalogs served by the route interceptor.
# Each provider gets a unique skill name so we can prove that switching
# provider or workspace replaces the previous catalog entirely instead of
# leaking foreign entries into the slash menu.
SKILL_FIXTURES: dict[str, dict[str, Any]] = {
    "gjc": {
        "name": "gjc-cua-13-only",
        "command": "/gjc-cua-13-only",
        "description": "GJC-scoped skill (task-13 fixture)",
        "scope": "user",
        "sourcePath": "/tmp/task-13/gjc/skills/gjc-cua-13-only",
    },
    "omo": {
        "name": "omo-cua-13-only",
        "command": "/omo-cua-13-only",
        "description": "OMO-scoped skill (task-13 fixture)",
        "scope": "user",
        "sourcePath": "/tmp/task-13/omo/skills/omo-cua-13-only",
    },
    "codex": {
        "name": "codex-cua-13-only",
        "command": "$codex-cua-13-only",
        "description": "Codex-scoped skill (task-13 fixture)",
        "scope": "user",
        "sourcePath": "/tmp/task-13/codex/skills/codex-cua-13-only",
    },
}

# Names present in the built-in server catalog. When the /api/providers/*/skills
# fetch fails we still expect at least one of these to survive.
BUILT_IN_COMMAND_NAMES = {
    "/help", "/models", "/cost", "/memory", "/config", "/status",
    "$help", "$models", "$cost", "$memory", "$config", "$status",
}


class SkillsInterceptor:
    """Owns the /api/providers/:provider/skills route mock.

    Modes:
      * ``normal``  — fulfil with the fixture for the requested provider.
      * ``slow``    — wait on an explicit release event before fulfilling.
                      Used to surface out-of-order responses without timing
                      luck so we can verify cancellation of stale writes.
      * ``fail``    — fulfil with HTTP 500. Used to prove that a provider
                      skill fetch failure clears skills but keeps built-in
                      and custom commands.

    Provider modes are keyed by provider name so an OMO fetch can be slow
    while a GJC fetch remains fast within the same run.
    """

    def __init__(self) -> None:
        self.provider_mode: dict[str, str] = {}
        self.default_mode: str = "normal"
        self.requests: list[dict[str, Any]] = []
        self.slow_started = threading.Event()
        self.slow_release = threading.Event()
        self.slow_responses: list[Any] = []
        self.completion_order = 0
        self.slow_finished = threading.Event()
        self.commands_requested = threading.Event()

    def configure(
        self,
        *,
        default: str | None = None,
        providers: dict[str, str] | None = None,
    ) -> None:
        if default is not None:
            self.default_mode = default
        if providers is not None:
            self.provider_mode = dict(providers)
            if "slow" in providers.values():
                self.slow_started.clear()
                self.slow_release.clear()
                self.slow_finished.clear()

    def reset_recording(self) -> None:
        self.requests = []

    def _handle(self, route: Route) -> None:
        request = route.request
        match = SKILLS_URL_RE.search(request.url)
        if not match:
            route.fallback()
            return
        provider = match.group(1)
        mode = self.provider_mode.get(provider, self.default_mode)
        record: dict[str, Any] = {
            "provider": provider,
            "url": request.url,
            "mode": mode,
            "workspacePath": None,
            "startedAtMs": int(time.time() * 1000),
        }
        try:
            query = request.url.split("?", 1)[1] if "?" in request.url else ""
            for pair in query.split("&"):
                if pair.startswith("workspacePath="):
                    from urllib.parse import unquote

                    record["workspacePath"] = unquote(pair.split("=", 1)[1])
                    break
        except Exception:  # noqa: BLE001 — record best-effort; never crash the route
            pass

        if mode == "fail":
            record["fulfilledStatus"] = 500
            self.requests.append(record)
            route.fulfill(
                status=500,
                content_type="application/json",
                body=json.dumps(
                    {
                        "success": False,
                        "error": {
                            "code": "PROVIDER_SKILLS_SYNTHETIC_FAILURE",
                            "message": "Synthetic CUA task-13 failure",
                        },
                    }
                ),
            )
            return

        recorded = False
        if mode == "slow":
            self.requests.append(record)
            recorded = True
            self.slow_started.set()

        skill = SKILL_FIXTURES.get(provider)
        trigger = "$" if provider == "codex" else "/"
        native_builtins = [
            {
                "name": f"cua-builtin-{name[1:]}",
                "command": f"{trigger}{name[1:]}",
                "description": f"CUA native built-in {name[1:]}",
                "scope": "builtin",
                "sourcePath": None,
                "pluginName": None,
                "pluginId": None,
            }
            for name in sorted(name for name in BUILT_IN_COMMAND_NAMES if name.startswith("/"))
        ]
        skills_body = native_builtins + ([{
            **skill,
            "pluginName": None,
            "pluginId": None,
        }] if skill else [])
        record["fulfilledStatus"] = 200
        record["skills"] = [entry["name"] for entry in skills_body]
        if not recorded:
            self.requests.append(record)
        def complete() -> None:
            try:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {"success": True, "data": {"provider": provider, "skills": skills_body}}
                    ),
                )
                record["completion"] = "fulfilled"
            except Exception:  # noqa: BLE001 - cancellation is the behavior under test
                record["completion"] = "cancelled"
            finally:
                self.completion_order += 1
                record["completionOrder"] = self.completion_order
                if mode == "slow":
                    self.slow_finished.set()
        if mode == "slow":
            # Keep this request pending without blocking Playwright's event loop.
            self.slow_responses.append(complete)
        else:
            complete()

    def release_slow(self) -> None:
        if not self.slow_responses:
            raise AssertionError("no delayed response was armed")
        pending, self.slow_responses = self.slow_responses, []
        for complete in pending:
            complete()

    def _commands(self, route: Route) -> None:
        self.commands_requested.set()
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "builtIn": [
                    {"name": name, "namespace": "builtin", "description": f"CUA built-in {name}"}
                    for name in sorted(BUILT_IN_COMMAND_NAMES)
                ],
                "custom": [],
            }),
        )

    def install(self, context: Any) -> None:
        context.route(SKILLS_URL_RE, self._handle)
        context.route("**/api/commands/list", self._commands)


def arm_log_event(log_path: str, event_type: str, timeout_seconds: float = 10):
    """Subscribe to the owned NDJSON file before triggering the browser action."""
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_CLOEXEC)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "inotify_init1 failed")
    if libc.inotify_add_watch(fd, os.fsencode(log_path), 0x00000002 | 0x00000008) < 0:
        os.close(fd)
        raise OSError(ctypes.get_errno(), "inotify_add_watch failed")
    offset = os.path.getsize(log_path)

    def wait() -> bool:
        nonlocal offset
        deadline = time.monotonic() + timeout_seconds
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                    raise TimeoutError(f"Timed out waiting for {event_type}")
                os.read(fd, 4096)
                with open(log_path, "r", encoding="utf-8") as log:
                    log.seek(offset)
                    appended = log.read()
                    offset = log.tell()
                if any(json.loads(line).get("type") == event_type for line in appended.splitlines() if line):
                    return True
        finally:
            os.close(fd)

    return wait


def arm_dom(page: Any, key: str, selector: str, expression: str) -> None:
    page.evaluate("""({ key, selector, expression }) => {
      window.__cuaDomSignals ??= {};
      const predicate = new Function('node', `return (${expression});`);
      window.__cuaDomSignals[key] = new Promise((resolve, reject) => {
        const inspect = () => [...document.querySelectorAll(selector)].find(predicate);
        const observer = new MutationObserver(() => { const node = inspect(); if (node) finish(node); });
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM signal timed out: ${key}`)); }, 15000);
        const finish = (node) => { clearTimeout(timeout); observer.disconnect(); resolve({ text: node.textContent }); };
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const existing = inspect(); if (existing) finish(existing);
      });
    }""", {"key": key, "selector": selector, "expression": expression})


def await_dom(page: Any, key: str) -> dict[str, Any]:
    return page.evaluate("key => window.__cuaDomSignals[key]", key)


def arm_file_creation(directory: Path, prefix: str, timeout_seconds: float = 15):
    directory.mkdir(parents=True, exist_ok=True)
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_CLOEXEC)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "inotify_init1 failed")
    if libc.inotify_add_watch(fd, os.fsencode(directory), 0x00000100 | 0x00000080) < 0:
        os.close(fd)
        raise OSError(ctypes.get_errno(), "inotify_add_watch failed")

    def wait() -> Path:
        deadline = time.monotonic() + timeout_seconds
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                    raise TimeoutError(f"Timed out waiting for file prefix {prefix}")
                data = os.read(fd, 4096)
                offset = 0
                while offset + 16 <= len(data):
                    _wd, _mask, _cookie, name_length = __import__("struct").unpack_from("iIII", data, offset)
                    name = data[offset + 16:offset + 16 + name_length].rstrip(b"\0").decode()
                    offset += 16 + name_length
                    if name.startswith(prefix):
                        return directory / name
        finally:
            os.close(fd)

    return wait


def arm_storage_change(page: Any, key: str, old_value: str | None) -> None:
    page.evaluate("""({ key, oldValue }) => {
      window.__cuaStorageSignal = new Promise((resolve, reject) => {
        const native = Storage.prototype.setItem;
        const timeout = setTimeout(() => reject(new Error(`Storage change timed out: ${key}`)), 10000);
        Storage.prototype.setItem = function(name, value) {
          native.call(this, name, value);
          if (name === key && value !== oldValue) {
            clearTimeout(timeout); Storage.prototype.setItem = native; resolve(value);
          }
        };
      });
    }""", {"key": key, "oldValue": old_value})


def capture_pane(manifest: dict[str, Any], session_name: str) -> str:
    socket_path = manifest["fleet"]["hub"]["socketPath"]
    return subprocess.run(
        ["tmux", "-S", socket_path, "capture-pane", "-p", "-S", "-", "-t", f"={session_name}:"],
        check=True,
        capture_output=True,
        env={key: value for key, value in os.environ.items() if key not in {"TMUX", "TMUX_PANE"}},
        text=True,
    ).stdout


def set_viewport(page: Any, width: int, height: int) -> None:
    session = page.context.new_cdp_session(page)
    session.send("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": width < 640,
    })
    VIEWPORT_SESSIONS.append(session)


def read_slash_menu_names(page: Any) -> list[str]:
    """Return every command name visible in the open slash menu.

    Uses the accessible listbox exposed by ``CommandMenu`` (role=listbox,
    aria-label='Available commands') and enumerates its role=option children.
    """
    listbox = page.get_by_role("listbox", name="Available commands")
    listbox.wait_for(timeout=5_000)
    options = listbox.get_by_role("option")
    count = options.count()
    names: list[str] = []
    for index in range(count):
        text = options.nth(index).locator("span.font-mono").first.inner_text().strip()
        if text:
            names.append(text)
    return names


def open_slash_menu_via_typing(page: Any, trigger: str = "/") -> None:
    """Focus the composer and type its provider-native command trigger.

    The command menu is a React portal keyed off composer state, so we rely
    on the same trigger a user has and wait for the listbox to render.
    Slash-based providers use ``/`` while Codex uses ``$``.
    """
    composer = page.locator("textarea").first
    composer.click()
    # Clear whatever draft is in the composer so the input becomes a fresh
    # command-menu trigger. Selecting-all-and-typing avoids any prior
    # text becoming part of the query.
    composer.press("Control+a")
    composer.press("Delete")
    composer.type(trigger)
    try:
        page.get_by_role("listbox", name="Available commands").wait_for(timeout=8_000)
    except PlaywrightTimeoutError:
        page.screenshot(path=evidence_root / "slash-menu-failure.png")
        (evidence_root / "slash-menu-failure.json").write_text(json.dumps({
            "url": page.url, "trigger": trigger, "input": composer.input_value(),
            "requests": interceptor.requests, "visibleText": page.locator("body").inner_text(),
        }, indent=2), encoding="utf-8")
        raise


def close_slash_menu(page: Any) -> None:
    composer = page.locator("textarea").first
    composer.focus()
    composer.press("Escape")
    # Clear the leftover '/'
    composer.press("Control+a")
    composer.press("Delete")


def switch_to_agent_row(page: Any, tmux_name: str, provider: str) -> dict[str, Any]:
    """Click a sidebar row and observe its skills catalog.

    The hook may reuse a catalog fetched earlier in the same page lifetime.
    A cached switch is valid when the interceptor already recorded the
    matching provider request; the slash-menu assertion still verifies the
    observable catalog after the click.
    """
    row = page.get_by_text(tmux_name, exact=True).first
    row.wait_for(timeout=15_000)
    try:
        with page.expect_response(
            lambda response: (
                SKILLS_URL_RE.search(response.url) is not None
                and f"/api/providers/{provider}/skills" in response.url
            ),
            timeout=5_000,
        ) as response_info:
            row.locator("xpath=ancestor::button[1]").click()
            chat_tab = page.get_by_role("tab", name="Chat", exact=True)
            if chat_tab.count() > 0:
                chat_tab.click()
        response = response_info.value
        return {
            "url": response.url,
            "status": response.status,
            "cached": False,
        }
    except PlaywrightTimeoutError:
        chat_tab = page.get_by_role("tab", name="Chat", exact=True)
        if chat_tab.count() > 0:
            chat_tab.click()
        previous = next(
            (
                request
                for request in reversed(interceptor.requests)
                if request["provider"] == provider
            ),
            None,
        )
        if previous is None:
            page.screenshot(path=evidence_root / "slash-switch-failure.png")
            (evidence_root / "slash-switch-failure.json").write_text(json.dumps({
                "provider": provider,
                "url": page.url,
                "requests": interceptor.requests,
                "visibleText": page.locator("body").inner_text(),
            }, indent=2), encoding="utf-8")
            raise
        return {
            "url": previous["url"],
            "status": previous["fulfilledStatus"],
            "cached": True,
        }


def create_session(
    page: Any,
    *,
    provider_label: str,
    session_name: str,
    workspace: str,
    spawn_log_directory: Path,
) -> Path:
    page.locator("button[data-spawn-open]").click()
    local_host = page.locator("button[data-spawn-host='local']")
    # With no currently spawnable peer the host chooser is intentionally absent;
    # the form is already local. When it is present, select local explicitly.
    if local_host.count() > 0:
        local_host.click()
    provider = {
        "Codex": "codex",
        "Oh My OpenAgent": "omo",
    }[provider_label]
    page.locator(f"button[data-spawn-provider='{provider}']").click()
    page.get_by_placeholder(
        "Session name (letters and numbers, e.g. my-feature)"
    ).fill(session_name)
    workspace_input = page.get_by_placeholder(
        "Working folder (e.g. ~/workspace/my-proj or an absolute path)"
    )
    workspace_input.fill(workspace)
    workspace_input.press("Escape")
    arm_dom(page, "session-created", "button", f"node.textContent.includes({json.dumps(session_name)})")
    created_log = arm_file_creation(spawn_log_directory, "codex-")
    page.get_by_role("button", name="Create", exact=True).click()
    await_dom(page, "session-created")
    return created_log()


manifest = json.loads(CURRENT_PATH.read_text(encoding="utf-8"))
manifest_evidence_root = Path(manifest["evidenceRoot"])
# The task pipeline pins CUA_EVIDENCE_DIR to the requirement-specific folder
# under .omo/evidence/... Fall back to the fixture-owned evidence root when
# it's unset so ad-hoc runs still land somewhere sensible.
evidence_root_env = os.environ.get("CUA_EVIDENCE_DIR")
evidence_root = Path(evidence_root_env) if evidence_root_env else manifest_evidence_root
evidence_root.mkdir(parents=True, exist_ok=True)

cdp_url = os.environ.get("CUA_CDP_URL", "http://127.0.0.1:9333")
session_url = f"{manifest['baseUrl']}/session/{SESSION_ID}"
gjc_agent = next(agent for agent in manifest["agents"] if agent["kind"] == "gjc")
harness_home = str(Path(manifest["harnessRoot"]) / "home")
results: dict[str, Any] = {
    "mode": "browser_cdp_fallback",
    "sessionUrl": session_url,
    "evidenceRoot": str(evidence_root),
    "checks": {},
    "artifacts": {},
    "slashMenu": {},
}

interceptor = SkillsInterceptor()

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(cdp_url)
    context = browser.contexts[0]
    # Install the /api/providers/:provider/skills mock before navigation so
    # the very first fetch (GJC on page load) hits deterministic data.
    interceptor.install(context)
    interceptor.configure(default="normal")

    page = context.new_page()
    set_viewport(page, 1600, 1000)
    page.goto(session_url, wait_until="domcontentloaded")
    gjc_row = page.get_by_text("cua-06-gjc", exact=True).first
    gjc_row.wait_for(timeout=15_000)
    gjc_row.locator("xpath=ancestor::button[1]").click()
    page.get_by_role("tab", name="Chat", exact=True).wait_for(timeout=15_000)

    # Create the codex session used by the existing "session_created" and
    # "session_switched" checks.
    spawned_log = create_session(
        page,
        provider_label="Codex",
        session_name=CREATED_SESSION,
        workspace=harness_home,
        spawn_log_directory=Path(harness_home) / ".chatmux-cua-spawned",
    )
    results["checks"]["session_created"] = {
        "ok": page.get_by_text(CREATED_SESSION, exact=True).count() > 0,
        "session": CREATED_SESSION,
    }
    created_pane = capture_pane(manifest, CREATED_SESSION)
    (evidence_root / "created-pane.txt").write_text(created_pane, encoding="utf-8")
    spawned_logs = [spawned_log]
    results["checks"]["isolated_fake_spawn"] = {
        "ok": (
            "ChatMux CUA fixture ready: codex" in created_pane
            and len(spawned_logs) == 1
        ),
        "spawnedLogs": [str(path) for path in spawned_logs],
        "paneReady": "ChatMux CUA fixture ready: codex" in created_pane,
    }

    def check_reorder() -> None:
        order_before = page.evaluate(f"localStorage.getItem('{ORDER_STORAGE_KEY}')")
        arm_storage_change(page, ORDER_STORAGE_KEY, order_before)
        drag_handle = page.get_by_role(
            "button",
            name="Drag to reorder session 'cua-07-omp'",
            exact=True,
        )
        over_handle = page.get_by_role(
            "button",
            name="Drag to reorder session 'cua-06-gjc'",
            exact=True,
        )
        source_box = drag_handle.bounding_box()
        target_box = over_handle.bounding_box()
        if source_box is None or target_box is None:
            raise AssertionError("reorder handles are not visible")
        page.mouse.move(source_box["x"] + source_box["width"] / 2, source_box["y"] + source_box["height"] / 2)
        page.mouse.down()
        page.mouse.move(target_box["x"] + target_box["width"] / 2, target_box["y"] + target_box["height"] / 2, steps=20)
        page.mouse.up()
        order_after = page.evaluate("window.__cuaStorageSignal")
        results["checks"]["session_reordered"] = {
            "ok": bool(order_after and order_after != order_before),
            "before": json.loads(order_before) if order_before else [],
            "after": json.loads(order_after) if order_after else [],
        }

    # ────────────────────────────────────────────────────────────────
    # Slash-menu safety across provider/workspace changes and failures.
    #
    # The claim under test: switching provider or workspace, or a synthetic
    # skills-endpoint failure, can never surface skills from a previous
    # provider in the slash menu, but built-in commands must survive.
    # ────────────────────────────────────────────────────────────────
    # 1. Provider/workspace switch: the fixture-owned OMO pane runs in the
    #    project workspace while the created Codex pane runs in HOME.
    interceptor.configure(default="normal", providers={})
    omo_switch = switch_to_agent_row(page, CREATED_OMO_SESSION, "omo")

    # On this switch we're now on OMO. Open the slash menu.
    open_slash_menu_via_typing(page)
    omo_menu_names = read_slash_menu_names(page)
    if not interceptor.commands_requested.is_set():
        raise AssertionError("local built-in command inventory was not requested")
    page.screenshot(path=evidence_root / "slash-menu-omo.png")
    close_slash_menu(page)
    omo_has_own = SKILL_FIXTURES["omo"]["command"] in omo_menu_names
    omo_leaks_gjc = SKILL_FIXTURES["gjc"]["command"] in omo_menu_names
    omo_leaks_codex = SKILL_FIXTURES["codex"]["command"] in omo_menu_names
    omo_keeps_builtin = any(name in BUILT_IN_COMMAND_NAMES for name in omo_menu_names)

    # 2. Switch back to the ChatMux-created Codex session. GJC uses the
    #    separate live palette covered by task 12; it is not a New-session
    #    provider for this app-session slash-menu hook.
    codex_switch = switch_to_agent_row(page, CREATED_SESSION, "codex")
    open_slash_menu_via_typing(page, "$")
    codex_menu_names = read_slash_menu_names(page)
    page.screenshot(path=evidence_root / "slash-menu-codex-after-omo.png")
    close_slash_menu(page)
    codex_has_own = SKILL_FIXTURES["codex"]["command"] in codex_menu_names
    codex_leaks_omo = SKILL_FIXTURES["omo"]["command"] in codex_menu_names
    codex_leaks_gjc = SKILL_FIXTURES["gjc"]["command"] in codex_menu_names
    codex_keeps_builtin = any(name in BUILT_IN_COMMAND_NAMES for name in codex_menu_names)

    results["slashMenu"]["providerAndWorkspaceSwitch"] = {
        "omoMenu": omo_menu_names,
        "codexMenu": codex_menu_names,
        "omoRequestUrl": omo_switch["url"],
        "codexRequestUrl": codex_switch["url"],
    }
    results["checks"]["slash_menu_provider_switch_no_leak"] = {
        "ok": all([
            omo_has_own,
            not omo_leaks_gjc,
            not omo_leaks_codex,
            omo_keeps_builtin,
            codex_has_own,
            not codex_leaks_omo,
            not codex_leaks_gjc,
            codex_keeps_builtin,
        ]),
        "omoHasOwn": omo_has_own,
        "omoLeaksGjc": omo_leaks_gjc,
        "omoLeaksCodex": omo_leaks_codex,
        "omoKeepsBuiltin": omo_keeps_builtin,
        "codexHasOwn": codex_has_own,
        "codexLeaksOmo": codex_leaks_omo,
        "codexLeaksGjc": codex_leaks_gjc,
        "codexKeepsBuiltin": codex_keeps_builtin,
    }

    # The workspacePath change is observable directly on the request URLs.
    omo_ws_url = omo_switch["url"]
    codex_ws_url = codex_switch["url"]
    results["checks"]["slash_menu_workspace_switch_isolated"] = {
        "ok": all([
            "workspacePath=" in omo_ws_url,
            "workspacePath=" in codex_ws_url,
            omo_ws_url != codex_ws_url,
        ]),
        "omoRequestUrl": omo_ws_url,
        "codexRequestUrl": codex_ws_url,
    }

    # 3. Out-of-order / cancelled response: make the OMO skills fetch slow,
    #    click OMO, then Codex. Codex's fast response commits first; the stale
    #    OMO response must be dropped by useSlashCommands' cancellation
    #    guard rather than overwriting the current provider's catalog.
    interceptor.reset_recording()
    interceptor.configure(providers={"omo": "slow"})

    # Kick the slow OMO request without waiting for it to return.
    omo_row = page.get_by_text(CREATED_OMO_SESSION, exact=True).first
    omo_row.wait_for(timeout=10_000)
    with page.expect_request(lambda request: "/api/providers/omo/skills" in request.url, timeout=10_000):
        omo_row.locator("xpath=ancestor::button[1]").click()

    # Switch straight back to Codex. The Codex fetch runs at normal speed and
    # must finish before OMO's delayed fulfilment.
    with page.expect_response(
        lambda response: "/api/providers/codex/skills" in response.url and response.status == 200,
        timeout=15_000,
    ) as codex_fast_info:
        codex_row_reclick = page.get_by_text(CREATED_SESSION, exact=True).first
        codex_row_reclick.wait_for(timeout=10_000)
        codex_row_reclick.locator("xpath=ancestor::button[1]").click()
    codex_fast_response = codex_fast_info.value

    # Release the delayed OMO request only after Codex has committed. React may
    # cancel the stale request entirely; either cancellation or late fulfilment
    # must leave the currently selected Codex catalog unchanged.
    interceptor.release_slow()
    omo_late_record = next(
        request
        for request in interceptor.requests
        if request["provider"] == "omo" and request["mode"] == "slow"
    )
    codex_fast_record = next(request for request in interceptor.requests if request["provider"] == "codex")
    if omo_late_record["completionOrder"] <= codex_fast_record["completionOrder"]:
        raise AssertionError("the stale response did not actually settle after the new provider")

    open_slash_menu_via_typing(page, "$")
    reordered_menu_names = read_slash_menu_names(page)
    page.screenshot(path=evidence_root / "slash-menu-after-out-of-order.png")
    close_slash_menu(page)

    results["slashMenu"]["outOfOrder"] = {
        "codexFastResponseUrl": codex_fast_response.url,
        "omoLateResponseUrl": omo_late_record["url"],
        "omoLateCompletion": omo_late_record.get("completion"),
        "menuNames": reordered_menu_names,
        "requestRecords": interceptor.requests,
    }
    results["checks"]["slash_menu_out_of_order_response_ignored"] = {
        "ok": all([
            SKILL_FIXTURES["codex"]["command"] in reordered_menu_names,
            SKILL_FIXTURES["omo"]["command"] not in reordered_menu_names,
            SKILL_FIXTURES["gjc"]["command"] not in reordered_menu_names,
        ]),
        "codexVisible": SKILL_FIXTURES["codex"]["command"] in reordered_menu_names,
        "omoLeaked": SKILL_FIXTURES["omo"]["command"] in reordered_menu_names,
        "gjcLeaked": SKILL_FIXTURES["gjc"]["command"] in reordered_menu_names,
    }

    # 4. Synthetic 500 on skills. The menu must drop the previous provider's
    #    skills catalog entirely while built-in and custom commands survive.
    interceptor.reset_recording()
    # A persisted, inactive app session exercises useSlashCommandCatalog.
    # Live GJC has its own native palette and does not consume this endpoint.
    interceptor.configure(providers={"claude": "fail"})
    inactive_project = Path(harness_home) / "cua-inactive-project"
    inactive_project.mkdir(exist_ok=True)
    app_response = context.request.post(f"{manifest['baseUrl']}/api/providers/sessions", data={"provider": "claude", "projectPath": str(inactive_project)})
    if app_response.status != 201:
        raise AssertionError(f"inactive app session creation failed: {app_response.status}: {app_response.text()}")
    app_session_id = app_response.json()["data"]["sessionId"]
    with page.expect_response(lambda response: "/api/providers/claude/skills" in response.url and response.status == 500, timeout=15_000) as failure_info:
        page.goto(f"{manifest['baseUrl']}/session/{app_session_id}", wait_until="domcontentloaded")
    fail_switch = {"status": failure_info.value.status, "url": failure_info.value.url}

    open_slash_menu_via_typing(page)
    failure_listbox = page.get_by_role("listbox", name="Available commands")
    failure_menu_names = read_slash_menu_names(page)
    failure_menu_visible = failure_listbox.is_visible()
    page.screenshot(path=evidence_root / "slash-menu-after-500.png")
    close_slash_menu(page)

    failure_builtin_visible = [
        name for name in failure_menu_names if name in BUILT_IN_COMMAND_NAMES
    ]
    failure_provider_skills_leaked = [
        name
        for name in failure_menu_names
        if name in {
            SKILL_FIXTURES["omo"]["command"],
            SKILL_FIXTURES["gjc"]["command"],
            SKILL_FIXTURES["codex"]["command"],
        }
    ]

    results["slashMenu"]["syntheticFailure"] = {
        "failedRequestUrl": fail_switch["url"],
        "failedStatus": fail_switch["status"],
        "menuNames": failure_menu_names,
        "builtInVisible": failure_builtin_visible,
        "requestRecords": interceptor.requests,
    }
    results["checks"]["slash_menu_500_clears_provider_skills"] = {
        "ok": all([
            fail_switch["status"] == 500,
            failure_menu_visible,
            len(failure_builtin_visible) > 0,
            not failure_provider_skills_leaked,
        ]),
        "status500Observed": fail_switch["status"] == 500,
        "menuVisible": failure_menu_visible,
        "builtInVisible": failure_builtin_visible,
        "providerSkillsLeaked": failure_provider_skills_leaked,
    }

    # Return the interceptor to normal-mode before the destructive checks so
    # the existing UI flow observes deterministic skill responses.
    interceptor.configure(default="normal", providers={})

    # Snap back to the GJC session so the existing interrupt/error checks
    # below run against the same provider they always did.
    gjc_row = page.get_by_text("cua-06-gjc", exact=True).first
    gjc_row.wait_for(timeout=10_000)
    gjc_row.locator("xpath=ancestor::button[1]").click()
    chat_tab = page.get_by_role("tab", name="Chat", exact=True)
    if chat_tab.count() > 0:
        chat_tab.click()

    # ────────────────────────────────────────────────────────────────
    # Existing destructive checks (interrupt, provider error state).
    # ────────────────────────────────────────────────────────────────
    composer = page.locator("textarea").first
    composer.fill(LONG_TURN_PROMPT)
    composer.press("Enter")
    page.get_by_role("button", name="Stop", exact=True).wait_for(timeout=10_000)
    interrupted_signal = arm_log_event(gjc_agent["logPath"], "turn_interrupted")
    try:
        page.get_by_role("button", name="Stop", exact=True).click()
    except PlaywrightTimeoutError:
        page.screenshot(path=evidence_root / "interrupt-failure.png")
        (evidence_root / "interrupt-failure.json").write_text(json.dumps({
            "visibleText": page.locator("body").inner_text(),
            "agentEvents": Path(gjc_agent["logPath"]).read_text(),
        }, indent=2), encoding="utf-8")
        raise
    interrupted = interrupted_signal()
    results["checks"]["interrupt"] = {
        "ok": interrupted,
        "prompt": LONG_TURN_PROMPT,
    }

    transcript_path = Path(manifest["gjcTranscriptPath"])
    arm_dom(page, "transcript-error", "body", "node.textContent.includes('ERROR')")
    with transcript_path.open("a", encoding="utf-8") as transcript:
        transcript.write(json.dumps({
            "type": "error",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error": {"message": "Synthetic CUA validation error"},
        }) + "\n")
        transcript.flush()
        os.fsync(transcript.fileno())
    await_dom(page, "transcript-error")
    error_badge = page.get_by_text("ERROR", exact=True).first
    results["checks"]["error_state"] = {"ok": error_badge.is_visible()}
    page.screenshot(path=evidence_root / "desktop-interactions.png")
    results["artifacts"]["desktop_interactions"] = str(
        evidence_root / "desktop-interactions.png"
    )

    created_row = page.get_by_text(CREATED_SESSION, exact=True).first
    arm_dom(page, "session-selected", "body", "node.textContent.includes('Codex transcript pending')")
    created_row.locator("xpath=ancestor::button[1]").click()
    await_dom(page, "session-selected")
    pending_heading = page.get_by_text("Codex transcript pending", exact=True)
    switch_screenshot = evidence_root / "desktop-session-switch.png"
    page.screenshot(path=switch_screenshot)
    results["checks"]["session_switched"] = {
        "ok": pending_heading.is_visible(),
        "session": CREATED_SESSION,
    }
    results["artifacts"]["desktop_session_switch"] = str(switch_screenshot)
    results["artifacts"]["slash_menu_omo"] = str(evidence_root / "slash-menu-omo.png")
    results["artifacts"]["slash_menu_codex_after_omo"] = str(
        evidence_root / "slash-menu-codex-after-omo.png"
    )
    results["artifacts"]["slash_menu_after_out_of_order"] = str(
        evidence_root / "slash-menu-after-out-of-order.png"
    )
    results["artifacts"]["slash_menu_after_500"] = str(
        evidence_root / "slash-menu-after-500.png"
    )

    # Drag-and-drop suppresses immediate follow-up clicks; test it last.
    check_reorder()

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

if not results["ok"]:
    sys.exit(1)

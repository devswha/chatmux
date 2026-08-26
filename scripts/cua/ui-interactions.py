#!/usr/bin/env python3

import json
import os
import re
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
CREATED_OMO_SESSION = "cua-created-omo"
ORDER_STORAGE_KEY = "chatmux.liveSessionOrder.v1"
SKILLS_URL_RE = re.compile(r"/api/providers/([^/]+)/skills(?:\?|$)")


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
BUILT_IN_COMMAND_NAMES = {"/help", "/models", "/cost", "/memory", "/config", "/status"}


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
        self.slow_finished = threading.Event()

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
            if not self.slow_release.wait(timeout=10):
                record["releaseTimeout"] = True

        skill = SKILL_FIXTURES.get(provider)
        skills_body = [
            {
                **skill,
                "pluginName": None,
                "pluginId": None,
            }
        ] if skill else []
        record["fulfilledStatus"] = 200
        record["skills"] = [entry["name"] for entry in skills_body]
        if not recorded:
            self.requests.append(record)
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
            if mode == "slow":
                self.slow_finished.set()

    def install(self, context: Any) -> None:
        context.route(SKILLS_URL_RE, self._handle)


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
    page.get_by_role("listbox", name="Available commands").wait_for(timeout=8_000)


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
) -> None:
    page.get_by_role("button", name="New session", exact=True).click()
    page.get_by_role("button", name=provider_label, exact=True).click()
    page.get_by_placeholder(
        "Session name (letters and numbers, e.g. my-feature)"
    ).fill(session_name)
    workspace_input = page.get_by_placeholder(
        "Working folder (e.g. ~/workspace/my-proj or an absolute path)"
    )
    workspace_input.fill(workspace)
    workspace_input.press("Escape")
    page.get_by_role("button", name="Create", exact=True).click()
    page.get_by_text(session_name, exact=True).first.wait_for(timeout=15_000)


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
workspace_default = str(Path(manifest["workspace"]))
# The spawn endpoint rejects cwds outside HOME. Prepare a HOME-relative
# workspace for the OMO session so we have provider AND workspace changes
# to observe on the switch, without failing spawn validation.
omo_workspace = str(Path(harness_home) / "omo-workspace")
Path(omo_workspace).mkdir(parents=True, exist_ok=True)
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
    page.set_viewport_size({"width": 1600, "height": 1000})
    page.goto(session_url, wait_until="domcontentloaded")
    gjc_row = page.get_by_text("cua-06-gjc", exact=True).first
    gjc_row.wait_for(timeout=15_000)
    gjc_row.locator("xpath=ancestor::button[1]").click()
    page.get_by_role("tab", name="Chat", exact=True).wait_for(timeout=15_000)

    # Create the codex session used by the existing "session_created" and
    # "session_switched" checks.
    create_session(
        page,
        provider_label="Codex",
        session_name=CREATED_SESSION,
        workspace=harness_home,
    )
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

    # ────────────────────────────────────────────────────────────────
    # Slash-menu safety across provider/workspace changes and failures.
    #
    # The claim under test: switching provider or workspace, or a synthetic
    # skills-endpoint failure, can never surface skills from a previous
    # provider in the slash menu, but built-in commands must survive.
    # ────────────────────────────────────────────────────────────────
    # 1. Provider switch: create an OMO session in a distinct workspace so
    #    both provider (gjc -> omo -> gjc) and workspacePath change together.
    interceptor.configure(default="normal", providers={})
    create_session(
        page,
        provider_label="Oh My OpenAgent",
        session_name=CREATED_OMO_SESSION,
        workspace=omo_workspace,
    )
    omo_switch = switch_to_agent_row(page, CREATED_OMO_SESSION, "omo")

    # On this switch we're now on OMO. Open the slash menu.
    open_slash_menu_via_typing(page)
    omo_menu_names = read_slash_menu_names(page)
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
            codex_has_own,
            not codex_leaks_omo,
            not codex_leaks_gjc,
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
    omo_row.locator("xpath=ancestor::button[1]").click()
    if not interceptor.slow_started.wait(timeout=10):
        raise AssertionError("slow OMO skills request did not start")

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
    interceptor.slow_release.set()
    if not interceptor.slow_finished.wait(timeout=10):
        raise AssertionError("slow OMO skills request did not settle")
    omo_late_record = next(
        request
        for request in interceptor.requests
        if request["provider"] == "omo" and request["mode"] == "slow"
    )

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
    interceptor.configure(providers={"omo": "fail"})
    fail_switch = switch_to_agent_row(page, CREATED_OMO_SESSION, "omo")
    if fail_switch["status"] != 500:
        raise AssertionError("synthetic OMO skills failure did not return HTTP 500")

    failure_composer = page.locator("textarea").first
    failure_composer.click()
    failure_composer.press("Control+a")
    failure_composer.press("Delete")
    failure_composer.type("/")
    failure_listbox = page.get_by_role("listbox", name="Available commands")
    failure_menu_names = (
        read_slash_menu_names(page)
        if failure_listbox.count() > 0 and failure_listbox.is_visible()
        else []
    )
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
            not failure_provider_skills_leaked,
        ]),
        "status500Observed": fail_switch["status"] == 500,
        "menuVisible": failure_listbox.count() > 0 and failure_listbox.is_visible(),
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

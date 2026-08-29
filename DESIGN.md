# ChatMux Design System

## 1. Atmosphere & Identity

A compact, quiet command deck for long-running coding-agent work. The signature is host-aware operational density: muted layered surfaces keep transcripts and terminals primary, while state, target, and destructive scope stay explicit at the action edge.

## 2. Color

All UI color is expressed through the HSL variables in `src/index.css` and their Tailwind semantic aliases.

| Role | Token | Usage |
| --- | --- | --- |
| Page | `--background` / `background` | App shell and navigation |
| Surface | `--card` / `card` | Panels and elevated controls |
| Text | `--foreground` / `foreground` | Primary text |
| Muted | `--muted`, `--muted-foreground` | Secondary surfaces and metadata |
| Primary | `--primary`, `--primary-foreground` | Primary actions and active state |
| Accent | `--accent`, `--accent-foreground` | Hover and selected affordances |
| Destructive | `--destructive`, `--destructive-foreground` | Termination and irreversible actions |
| Boundary | `--border`, `--input`, `--ring` | Dividers, controls, focus |

Status colors use the existing Tailwind emerald, amber, blue, and red ramps. They communicate machine state only; they are not decorative.

## 3. Typography

- Primary: `Pretendard Variable`, Pretendard, Encode Sans, system UI fallbacks.
- Terminal: the xterm stack declared by `TERMINAL_FONT_FAMILY`.
- Existing scale: 11px dense metadata, 12px captions, 14px controls/body, 16px primary body, and larger headings from Tailwind's standard scale.
- Labels remain short enough to avoid orphaned CJK particles; long machine identifiers truncate visually while remaining available in accessible names or titles.

## 4. Spacing & Layout

The base unit is 4px. Existing Tailwind spacing steps are the source of truth: 1/1.5 for dense inline controls, 2/3 for control padding, 4 for content gutters, and larger standard steps for page regions.

The app owns viewport scrolling through a fixed `inset-0` shell. Sidebar and main content own their inner scrolling; every flex scroll child uses `min-h-0`/`min-w-0`. Mobile surfaces respect safe-area variables from `src/index.css` and reflow at the existing `sm`/`md` breakpoints.

## 5. Components

### Action button
- Structure: native `button` with Lucide icon and concise label/title.
- Variants: neutral, primary, destructive.
- States: default, hover, focus-visible ring, disabled opacity/cursor, pending.
- Accessibility: native disabled semantics and a target-specific accessible name.
- Motion: color/opacity only, existing 150-200ms transitions.

### Host status badge
- Structure: compact semantic status text adjacent to the host label.
- Variants: online, connecting, syncing, degraded, offline, revoked, incompatible.
- States: stale/unavailable state disables all descendant actions.
- Accessibility: state is readable text, never color alone.

### Terminal target bar
- Structure: terminal icon, tmux name, host label, process generation, action cluster, close control.
- Variants: local and remote exact-pane target.
- States: ready, stale, syncing, offline, pending action, unknown outcome.
- Accessibility: every action names its host and termination scope; destructive actions require an explicit confirmation.
- Layout: wrapping cluster on mobile; single compact row when space permits.

### Destructive confirmation
- Structure: selected scope description plus confirm/cancel buttons.
- Variants: process termination, pane destruction, tmux-session destruction.
- Accessibility: copy states the distinct impact before confirmation; focus remains keyboard reachable.

## 6. Motion & Interaction

- Micro state transitions: 150ms ease-out.
- Standard panel transitions: 200ms ease-in-out.
- Animate only transform and opacity; existing color transitions remain allowed for interaction feedback.
- No decorative motion. Reduced-motion preferences are honored by the global stylesheet.

## 7. Depth & Surface

Mixed, restrained depth: tonal surface shifts and low-contrast borders define the operational shell; shadows are reserved for overlays and floating controls already established in `src/index.css`. Terminal and transcript content remain visually dominant.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target; body contrast at least 4.5:1 and large text/UI boundaries at least 3:1.
- Full keyboard reachability, visible focus rings, native disabled semantics, and text equivalents for all icon controls.
- Host, pane generation, stale state, and destructive scope must never be conveyed by color alone.
- Desktop, tablet, and 375px mobile layouts must avoid primary-content horizontal scrolling.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Legacy raw Tailwind status ramps | Existing application surfaces | Extracted system preserves shipped behavior; consolidation is outside Todo 17 | Address in a dedicated design-token cleanup |
| React dev-inspection tools are not installed | Project tooling | Dependency changes are outside the fleet terminal integration scope | Add in a dedicated frontend-tooling change |

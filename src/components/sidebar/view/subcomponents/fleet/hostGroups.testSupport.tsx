/**
 * Mounted-test harness for the sidebar's host groups: the real component tree,
 * the real English sidebar copy, a controllable browser websocket and a stubbed
 * roster endpoint. Nothing about host grouping is provable without a fixture
 * that can deliver two peers colliding on every label.
 */

import assert from 'node:assert/strict';

import i18next, { type i18n as I18n } from 'i18next';
import { type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import enSidebar from '../../../../../i18n/locales/en/sidebar.json';
import type { ServerEvent } from '../../../../../contexts/WebSocketContext';
import WebSocketContext from '../../../../../contexts/WebSocketContext';
import { FleetHostCatalogProvider } from '../../../../../fleet/discovery/FleetHostCatalogContext';
import {
  LOCAL_HOST_ID,
  PEER_A_HOST_ID,
  PEER_B_HOST_ID,
  peerDescriptor,
} from '../../../../../fleet/discovery/hostCatalog.testSupport';
import type { FleetPeerState } from '../../../../../../shared/fleet';
import type { ExternalTerminalTarget } from '../../../../../types/app';

import SidebarHostGroups, { type SidebarHostGroupsProps } from './SidebarHostGroups';

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export const LOCAL_SUMMARY: SidebarHostGroupsProps['local'] = {
  rowLabels: ['omg'],
  counts: { sessions: 1, panes: 1 },
};

export function rosterBody(
  states: { readonly peerA?: FleetPeerState; readonly peerB?: FleetPeerState } = {},
): Record<string, unknown> {
  return {
    success: true,
    data: {
      localHostId: LOCAL_HOST_ID,
      hosts: [
        peerDescriptor(LOCAL_HOST_ID, 'workstation'),
        peerDescriptor(PEER_A_HOST_ID, 'studio', states.peerA ?? 'online'),
        peerDescriptor(PEER_B_HOST_ID, 'studio', states.peerB ?? 'online'),
      ],
    },
  };
}

export async function sidebarI18n(): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { sidebar: enSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return instance;
}

export type HostGroupsHarness = {
  readonly renderer: ReactTestRenderer;
  readonly emit: (event: ServerEvent) => Promise<void>;
  readonly paths: readonly string[];
  readonly sent: readonly unknown[];
  readonly openedTerminals: readonly ExternalTerminalTarget[];
  readonly openedTranscripts: number;
  readonly dispose: () => Promise<void>;
};

function LocationProbe({ paths }: { paths: string[] }) {
  const location = useLocation();
  if (paths[paths.length - 1] !== location.pathname) paths.push(location.pathname);
  return null;
}

export async function mountHostGroups(options: {
  readonly roster: () => Response;
  readonly children?: ReactNode;
}): Promise<HostGroupsHarness> {
  const originalFetch = globalThis.fetch;
  const listeners = new Set<(event: ServerEvent) => void>();
  const paths: string[] = [];
  const sent: unknown[] = [];
  const openedTerminals: ExternalTerminalTarget[] = [];
  let openedTranscripts = 0;
  globalThis.fetch = (async () => options.roster()) as typeof globalThis.fetch;
  const i18n = await sidebarI18n();

  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nextProvider i18n={i18n}>
        <WebSocketContext.Provider
          value={{
            ws: null,
            latestMessage: null,
            isConnected: true,
            sendMessage: (message: unknown) => { sent.push(message); },
            subscribe: (listener: (event: ServerEvent) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          } as never}
        >
          <MemoryRouter initialEntries={['/']}>
            <LocationProbe paths={paths} />
            {/* One catalog subscription for the page, exactly as the app mounts it. */}
            <FleetHostCatalogProvider>
              <SidebarHostGroups
                local={LOCAL_SUMMARY}
                onRemotePaneOpen={(target) => openedTerminals.push(target)}
                onRemoteTranscriptOpen={() => { openedTranscripts += 1; }}
              >
                {options.children ?? <div data-local-sections="true" />}
              </SidebarHostGroups>
            </FleetHostCatalogProvider>
          </MemoryRouter>
        </WebSocketContext.Provider>
      </I18nextProvider>,
    );
    await tick();
  });
  assert.ok(renderer, 'the harness mounted');

  return {
    renderer,
    emit: async (event: ServerEvent) => {
      await act(async () => {
        for (const listener of [...listeners]) listener(event);
        await tick();
      });
    },
    paths,
    sent,
    openedTerminals,
    get openedTranscripts() { return openedTranscripts; },
    dispose: async () => {
      await act(async () => { renderer!.unmount(); await tick(); });
      globalThis.fetch = originalFetch;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type RowProps = {
  readonly 'aria-label'?: unknown;
  readonly 'aria-disabled'?: unknown;
  readonly disabled?: unknown;
  readonly onClick?: () => void;
  readonly type?: unknown;
};

/** Every remote row button rendered inside the host group whose heading matches. */
export function remoteRows(harness: HostGroupsHarness, hostId: string): RowProps[] {
  const section = harness.renderer.root.findAll((node) => (
    typeof node.type === 'string' && node.props['data-host-id'] === hostId
  ));
  assert.equal(section.length, 1, `exactly one group section for ${hostId}`);
  return section[0]!.findAll(
    (node) => node.type === 'button' && node.props['data-host-row'] === 'true',
    { deep: true },
  ).map((node) => node.props as RowProps);
}

export function groupHostIds(harness: HostGroupsHarness): string[] {
  return harness.renderer.root
    .findAll((node) => typeof node.type === 'string' && typeof node.props['data-host-id'] === 'string')
    .map((node) => node.props['data-host-id'] as string);
}

export function visibleText(harness: HostGroupsHarness): string {
  const texts: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') { texts.push(node); return; }
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (node === null || typeof node !== 'object') return;
    collect((node as { children?: unknown }).children);
  };
  collect(harness.renderer.toJSON());
  return texts.join(' ');
}

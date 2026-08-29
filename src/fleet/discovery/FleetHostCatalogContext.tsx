/**
 * One fleet catalog subscription for the whole page.
 *
 * The roster REST call and the catalog websocket stream are per-browser facts,
 * not per-component ones: the sidebar, the chat surface and the new-session form
 * all need the same host availability, and a second subscription would duplicate
 * every request and every resync.
 *
 * Outside the provider the context reports an empty catalog, which is exactly
 * what a component test or a fleet-less deployment should see: no hosts, no
 * remote behaviour, pre-fleet UI.
 */

import { createContext, type ReactNode, useContext } from 'react';

import { EMPTY_FLEET_HOST_CATALOG } from './hostCatalog';
import { useFleetHostDiscovery, type FleetHostDiscovery } from './useFleetHostDiscovery';

const LOCAL_ONLY: FleetHostDiscovery = {
  catalog: EMPTY_FLEET_HOST_CATALOG,
  hasRemoteHosts: false,
  refresh: () => undefined,
};

const FleetHostCatalogContext = createContext<FleetHostDiscovery>(LOCAL_ONLY);

/**
 * The context itself, so a surface can be mounted against a fixed catalog the
 * same way the websocket context is provided in tests.
 */
export { FleetHostCatalogContext };

export function useFleetHostCatalog(): FleetHostDiscovery {
  return useContext(FleetHostCatalogContext);
}

export function FleetHostCatalogProvider({ children }: { children: ReactNode }) {
  const discovery = useFleetHostDiscovery();
  return (
    <FleetHostCatalogContext.Provider value={discovery}>
      {children}
    </FleetHostCatalogContext.Provider>
  );
}

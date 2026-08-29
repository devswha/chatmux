/**
 * Browser environment for mounted fleet tests: an in-memory `localStorage` that
 * enumerates like the real one (the legacy-state migration sweeps `Object.keys`)
 * and a `common` i18n instance for the route's error surface.
 */

import i18next from 'i18next';

import enCommon from '../i18n/locales/en/common.json';

export function installBrowserGlobals() {
  const originals = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    fetch: globalThis.fetch,
  };
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
      clear: () => entries.clear(),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() { return entries.size; },
    },
  });
  // Object.keys(localStorage) drives the migration sweep, so the fake exposes
  // its entries as own enumerable properties the way the browser does.
  const proxy = new Proxy(Reflect.get(globalThis, 'localStorage') as Storage, {
    ownKeys: () => [...entries.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: proxy });

  return {
    entries,
    restore: () => {
      if (originals.localStorage) Object.defineProperty(globalThis, 'localStorage', originals.localStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
      globalThis.fetch = originals.fetch;
    },
  };
}

export async function commonI18n() {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { common: enCommon } },
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
  });
  return instance;
}

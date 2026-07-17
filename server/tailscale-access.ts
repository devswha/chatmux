import { spawn } from 'node:child_process';

/**
 * Read-only tailscale access-address discovery (관제탑 큐 #288, 1단계).
 *
 * Detects — never configures — how this server is reachable over the user's
 * tailnet, so the UI can show the ONE correct address instead of letting users
 * find the app through dev ports or plain-HTTP IPs (실사고: dev 5173 + HTTP 접속
 * → 느린 로딩 + PWA 격하). Promotes HTTPS `tailscale serve` fronts only:
 * a bare 100.x IP is deliberately NOT suggested because plain HTTP downgrades
 * PWA install and reproduces that incident. Auto-configuring serve is out of
 * scope by decision — it would auto-expose an unauthenticated shell-capable
 * app to the whole tailnet (2단계, explicit opt-in only).
 */

export interface TailscaleAccessInfo {
  installed: boolean;
  running: boolean;
  /** MagicDNS name without the trailing dot, e.g. "home-server.tail1e211e.ts.net". */
  dnsName: string | null;
  /** HTTPS serve fronts that proxy to THIS server's port, in status order. */
  httpsUrls: string[];
  /** One-line setup command when tailscale runs but no HTTPS front exists. */
  suggestedCommand: string | null;
}

const NOT_INSTALLED: TailscaleAccessInfo = {
  installed: false,
  running: false,
  dnsName: null,
  httpsUrls: [],
  suggestedCommand: null,
};

/** Default HTTPS port suggested for a new serve front (any free serve port works). */
export const SUGGESTED_SERVE_HTTPS_PORT = 8443;

export function buildServeSuggestion(serverPort: number): string {
  return `tailscale serve --bg --https=${SUGGESTED_SERVE_HTTPS_PORT} ${serverPort}`;
}

/**
 * Parses `tailscale serve status` text: blocks of
 *   https://host.ts.net:8449 (tailnet only)
 *   |-- / proxy http://127.0.0.1:3021
 * Returns the HTTPS front URLs whose proxy target is this server's port at
 * the ROOT path — a front proxying a subpath (e.g. /status of another daemon)
 * or another port must never be advertised as this app's address.
 */
export function parseServeStatus(statusText: string, serverPort: number): string[] {
  const urls: string[] = [];
  let currentFronts: string[] = [];
  for (const rawLine of statusText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      currentFronts = [];
      continue;
    }
    const front = /^(https?:\/\/\S+)/.exec(line);
    if (front && !line.startsWith('|--')) {
      currentFronts.push(front[1]);
      continue;
    }
    const proxy = /^\|--\s+(\S+)\s+proxy\s+(\S+)$/.exec(line);
    if (!proxy) {
      continue;
    }
    const [, path, target] = proxy;
    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      continue;
    }
    const isRootPath = path === '/';
    const isThisPort = targetUrl.port === String(serverPort);
    const isRootTarget = targetUrl.pathname === '/' || targetUrl.pathname === '';
    if (isRootPath && isThisPort && isRootTarget) {
      for (const url of currentFronts) {
        if (url.startsWith('https://') && !urls.includes(url)) {
          urls.push(url);
        }
      }
    }
    currentFronts = [];
  }
  return urls;
}

/** Parses `tailscale status --json` for backend state + MagicDNS self name. */
export function parseTailscaleStatus(jsonText: string): { running: boolean; dnsName: string | null } {
  try {
    const parsed = JSON.parse(jsonText) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const dnsNameRaw = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName : null;
    return {
      running: parsed.BackendState === 'Running',
      dnsName: dnsNameRaw ? dnsNameRaw.replace(/\.$/, '') : null,
    };
  } catch {
    return { running: false, dnsName: null };
  }
}

type CommandRunner = (args: string[]) => Promise<string>;

function runTailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tailscale', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('tailscale command timed out'));
    }, 4_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 256 * 1024) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('tailscale output too large'));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`tailscale exited with ${code}`));
      }
    });
  });
}

/** Read-only probe; every failure degrades to "not installed / nothing to show". */
export async function getTailscaleAccessInfo(
  serverPort: number,
  run: CommandRunner = runTailscale,
): Promise<TailscaleAccessInfo> {
  let statusJson: string;
  try {
    statusJson = await run(['status', '--json']);
  } catch {
    return NOT_INSTALLED;
  }
  const { running, dnsName } = parseTailscaleStatus(statusJson);
  if (!running) {
    return { installed: true, running: false, dnsName, httpsUrls: [], suggestedCommand: null };
  }
  let httpsUrls: string[] = [];
  try {
    httpsUrls = parseServeStatus(await run(['serve', 'status']), serverPort);
  } catch {
    // serve status may fail (older CLI / no config) — suggest setup below.
  }
  return {
    installed: true,
    running: true,
    dnsName,
    httpsUrls,
    suggestedCommand: httpsUrls.length === 0 ? buildServeSuggestion(serverPort) : null,
  };
}

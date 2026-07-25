const RELAY_KEY_DIAGNOSTIC_INTERVAL_MS = 60_000;

export type RelayKeyDiagnostic = Readonly<{
  code: 'relay_key_sent' | 'relay_key_refused_lineage' | 'relay_key_refused_generation';
  provider: string;
  count: number;
}>;

type RelayKeyDiagnosticCode = RelayKeyDiagnostic['code'];
type RelayKeyDiagnosticSink = (event: RelayKeyDiagnostic) => void;

const counts = new Map<string, number>();
const lastReportedAt = new Map<string, number>();
const sinkIds = new WeakMap<object, number>();
let nextSinkId = 1;

const defaultDiagnosticSink: RelayKeyDiagnosticSink = (event) => {
  console.warn('Relay key diagnostic:', event);
};

/**
 * Emits the process-scoped relay diagnostics at most once per code/provider per
 * minute for each sink. The payload deliberately contains no tmux identifier.
 */
export function createRelayKeyDiagnosticEmitter(
  diagnostic: RelayKeyDiagnosticSink | undefined = undefined,
  now: () => number = Date.now,
): (code: RelayKeyDiagnosticCode, provider: string) => void {
  const sink = diagnostic ?? defaultDiagnosticSink;
  const sinkId = sinkIds.get(sink) ?? nextSinkId++;
  sinkIds.set(sink, sinkId);

  return (code, provider) => {
    const key = `${sinkId}\u0000${code}\u0000${provider}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const reportedAt = now();
    if ((lastReportedAt.get(key) ?? -RELAY_KEY_DIAGNOSTIC_INTERVAL_MS) + RELAY_KEY_DIAGNOSTIC_INTERVAL_MS > reportedAt) return;
    lastReportedAt.set(key, reportedAt);
    sink({ code, provider, count });
  };
}

export const emitRelayKeyDiagnostic = createRelayKeyDiagnosticEmitter();

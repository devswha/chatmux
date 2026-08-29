/**
 * Working-directory input for a session created on a peer.
 *
 * It is deliberately not `HomeDirInput`. That input learns the *local* HOME and
 * accepts absolute paths under it; a peer's filesystem is not this machine's, so
 * completing against local HOME would offer paths that do not exist there and
 * would send a controller path over the wire. This input only ever holds a
 * peer-home-relative value and completes from the peer's own suggestions.
 */

import { useEffect, useRef, useState } from 'react';

import { requestHostJson, parseDirSuggestions } from '../../../../../fleet/hostApi/requests';
import { hostDirSuggestionsUrl, type HostScope } from '../../../../../fleet/hostApi/urls';

const DEBOUNCE_MS = 200;

type PeerDirInputProps = {
  scope: HostScope;
  projectLocalId: string | null;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  invalid: boolean;
};

export default function PeerDirInput({
  scope,
  projectLocalId,
  value,
  onChange,
  onSubmit,
  placeholder,
  invalid,
}: PeerDirInputProps) {
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (projectLocalId === null) {
      setSuggestions([]);
      return undefined;
    }
    const prefix = value.trim();
    const seq = ++requestSeqRef.current;
    const timer = setTimeout(() => {
      void requestHostJson(hostDirSuggestionsUrl(scope, projectLocalId, prefix)).then((result) => {
        if (seq !== requestSeqRef.current) return;
        const entries = result.ok ? parseDirSuggestions(result.value) : [];
        setSuggestions(entries.filter((entry) => entry !== prefix));
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectLocalId, scope, value]);

  const pick = (suggestion: string) => {
    onChange(`${suggestion}/`);
    setOpen(true);
  };

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => { window.setTimeout(() => setOpen(false), 150); }}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && open && suggestions.length > 0) {
            event.preventDefault();
            pick(suggestions[0] ?? '');
            return;
          }
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            setOpen(false);
            onSubmit();
          }
        }}
        placeholder={placeholder}
        aria-invalid={invalid}
        data-peer-cwd-input
        className={`w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none ${
          invalid ? 'border-red-500/60' : 'border-border focus:border-primary/60'
        }`}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              data-peer-cwd-suggestion={suggestion}
              // onMouseDown so the pick beats the input's onBlur close.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              className="block w-full truncate px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

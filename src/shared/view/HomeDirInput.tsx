import { useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { formatSuggestionLike, toHomeRelative } from '../homePath';

type HomeDirInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
};

const DEBOUNCE_MS = 200;

/**
 * Home-anchored directory input with server-backed autocomplete
 * (/api/providers/fs/dir-suggestions). Accepts bare home-relative, '~/', and
 * absolute-under-home input; suggestions complete in the same style the user
 * is typing (previously '~/' and absolute input silently got NO suggestions —
 * the endpoint takes home-relative prefixes only). Click or Tab (first match)
 * completes. Best-effort — endpoint errors just hide the dropdown.
 */
export default function HomeDirInput({ value, onChange, onSubmit, placeholder, className }: HomeDirInputProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  // Absolute HOME path, learned from the endpoint (every response carries it).
  // Needed to normalize absolute input into the endpoint's home-relative form.
  const [home, setHome] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    const relative = toHomeRelative(value, home);
    if (relative === null) {
      setSuggestions([]);
      // An absolute path was typed before we learned HOME — fetch it once and
      // let the state update re-run this effect with the same input.
      if (home === null && value.trim().startsWith('/')) {
        void (async () => {
          try {
            const response = await api.dirSuggestions('');
            const body = await response.json();
            const learnedHome = body?.data?.home;
            if (typeof learnedHome === 'string' && learnedHome) {
              setHome(learnedHome);
            }
          } catch {
            // best-effort
          }
        })();
      }
      return undefined;
    }
    const seq = ++requestSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const response = await api.dirSuggestions(relative);
        if (!response.ok) return;
        const body = await response.json();
        const learnedHome = body?.data?.home;
        if (typeof learnedHome === 'string' && learnedHome) {
          setHome(learnedHome);
        }
        const list: string[] = body?.data?.suggestions ?? [];
        if (seq === requestSeqRef.current) {
          const styled = list.map((entry) => formatSuggestionLike(value, learnedHome ?? home, entry));
          // Typing the exact suggestion should collapse the dropdown.
          setSuggestions(styled.filter((entry) => entry !== value.trim()));
        }
      } catch {
        // best-effort
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, home]);

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
        onBlur={() => {
          // Delay so a click on a suggestion still lands.
          window.setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && suggestions.length > 0 && open) {
            event.preventDefault();
            pick(suggestions[0]);
            return;
          }
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            setOpen(false);
            onSubmit?.();
          }
        }}
        placeholder={placeholder}
        className={className ?? 'w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-blue-500/60'}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
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

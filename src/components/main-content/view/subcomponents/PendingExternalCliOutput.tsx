import React, { useEffect, useRef } from 'react';

type PendingExternalCliOutputProps = {
  providerLabel: string;
  output: string;
  emptyMessage?: string;
};

export default function PendingExternalCliOutput({
  providerLabel,
  output,
  emptyMessage,
}: PendingExternalCliOutputProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);

  useEffect(() => {
    if (!output) {
      followTailRef.current = true;
      return;
    }
    const viewport = viewportRef.current;
    if (viewport && followTailRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (!output) return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const keepTailVisible = () => {
      if (followTailRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    };
    const observer = new ResizeObserver(keepTailVisible);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [output]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followTailRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
  };

  if (!output) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex h-full max-w-[54.25rem] items-center justify-center text-center text-sm text-muted-foreground">
          {emptyMessage ?? `첫 지시를 보내면 ${providerLabel} transcript가 생성되어 이 화면에 자동으로 연결됩니다.`}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto bg-black px-4 py-3 text-left"
    >
      <pre
        aria-label={`${providerLabel} live terminal output`}
        className="mx-auto max-w-6xl whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-100"
      >
        {output}
      </pre>
    </div>
  );
}

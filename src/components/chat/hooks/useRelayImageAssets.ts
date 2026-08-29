/**
 * Image handling for the relay composer.
 *
 * Pasted and dropped images upload once through the shared asset store, and only
 * the resulting plain-text path is inserted into the draft — the relay itself has
 * no attachment channel, so the path leaves through the ordinary send. A returned
 * path outside the project or the asset store is rejected rather than inserted.
 */

import { useCallback, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';

import { api } from '../../../utils/api';
import { isRelayImagePathAllowed } from '../utils/liveRelayComposer';

export type RelayAssetStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading' }
  | { readonly kind: 'error'; readonly text: string };

export type RelayImageAssetsInput = {
  readonly workspacePath: string | null;
  readonly insertPath: (path: string) => void;
  readonly uploadFailedText: string;
  readonly pathRejectedText: string;
};

function imagesOf(files: readonly File[]): File[] {
  return files.filter((file) => file.type.startsWith('image/'));
}

export function useRelayImageAssets(input: RelayImageAssetsInput) {
  const [status, setStatus] = useState<RelayAssetStatus>({ kind: 'idle' });
  const { insertPath, pathRejectedText, uploadFailedText, workspacePath } = input;

  const upload = useCallback(async (files: readonly File[]) => {
    const imageFiles = imagesOf(files);
    if (imageFiles.length === 0) {
      return;
    }
    setStatus({ kind: 'uploading' });
    try {
      const response = await api.uploadImageAssets(imageFiles);
      const body = await response.json().catch(() => null);
      const images = Array.isArray(body?.images)
        ? (body.images as Array<{ path?: unknown; name?: unknown }>)
        : null;
      if (!response.ok || !images || images.length === 0) {
        setStatus({ kind: 'error', text: uploadFailedText });
        return;
      }
      let rejected = false;
      for (const image of images) {
        if (typeof image.path !== 'string' || !isRelayImagePathAllowed(image.path, workspacePath)) {
          rejected = true;
          continue;
        }
        insertPath(image.path);
      }
      setStatus(rejected ? { kind: 'error', text: pathRejectedText } : { kind: 'idle' });
    } catch {
      setStatus({ kind: 'error', text: uploadFailedText });
    }
  }, [insertPath, pathRejectedText, uploadFailedText, workspacePath]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void upload(imageFiles);
  }, [upload]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const imageFiles = imagesOf(Array.from(event.dataTransfer?.files ?? []));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void upload(imageFiles);
  }, [upload]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) {
      event.preventDefault();
    }
  }, []);

  return { status, upload, handlePaste, handleDrop, handleDragOver };
}

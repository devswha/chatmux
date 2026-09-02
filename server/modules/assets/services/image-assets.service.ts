import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Stored extension for an accepted mime type. The upload's original extension
 * is never trusted: multer's `mimetype` is the client-declared part header,
 * and a `.html` name behind an `image/png` declaration would otherwise be
 * served back as text/html on the app origin.
 */
const STORED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export function storedImageExtension(mimeType: string): string | null {
  return STORED_IMAGE_EXTENSIONS[mimeType] ?? null;
}

/** Content type to serve a stored asset with, from its stored extension only; null for anything else. */
export function imageContentTypeForStoredName(filename: string): string | null {
  const extension = path.extname(filename).toLowerCase();
  const entry = Object.entries(STORED_IMAGE_EXTENSIONS).find(([, storedExtension]) => storedExtension === extension);
  return entry?.[0] ?? null;
}

/** Display-safe base name: the original name without its extension, sanitized. */
export function sanitizedImageBaseName(originalName: string): string {
  const raw = path.basename(originalName);
  const extension = path.extname(raw);
  // A name that is only an extension (".html") has no base; basename() would keep it whole.
  // extname() reports no extension for a bare ".html", so a leading-dot-only name is also extension-only.
  const stem = extension ? raw.slice(0, -extension.length) : (raw.startsWith('.') ? '' : raw);
  const base = stem.replace(/[^a-zA-Z0-9.-]/g, '_');
  return base || 'image';
}

/** Creates the global `~/.chatmux/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.chatmux/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

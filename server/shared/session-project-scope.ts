import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function sessionBelongsToProject(
  sessionProjectPath: string | null | undefined,
  projectPath: string,
): boolean {
  if (!sessionProjectPath) return false;
  return path.resolve(sessionProjectPath) === path.resolve(projectPath);
}

export function isContainedTranscriptPath(realPath: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => {
    const resolved = path.resolve(root);
    return realPath === resolved || realPath.startsWith(`${resolved}${path.sep}`);
  });
}

export async function resolveContainedJsonlPath(
  jsonlPath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  try {
    const real = await realpath(jsonlPath);
    return isContainedTranscriptPath(real, allowedRoots) ? real : null;
  } catch {
    return null;
  }
}

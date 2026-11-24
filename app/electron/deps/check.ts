import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { DepDef, DepId } from './manifest';
import { fetchExpectedChecksum, readInstalledDb, type FetchLike } from './install';

export type DepState = 'ok' | 'missing' | 'broken';

export interface DepStatus {
  id: DepId;
  label: string;
  reason: string;
  state: DepState;
  version?: string;
  error?: string;
  /** null = not checked yet / check failed. */
  updateAvailable: boolean | null;
}

function runVersion(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.split(/\r?\n/)[0].trim());
    });
  });
}

export async function checkDep(def: DepDef, binDir: string): Promise<DepStatus> {
  const base = { id: def.id, label: def.label, reason: def.reason, updateAvailable: null };
  for (const f of def.files) {
    try {
      await access(join(binDir, f), constants.F_OK);
    } catch {
      return { ...base, state: 'missing' };
    }
  }
  try {
    const version = await runVersion(join(binDir, def.versionFile), def.versionArgs);
    return { ...base, state: 'ok', version };
  } catch (err) {
    return { ...base, state: 'broken', error: (err as Error).message };
  }
}

export function checkDeps(defs: DepDef[], binDir: string): Promise<DepStatus[]> {
  return Promise.all(defs.map((d) => checkDep(d, binDir)));
}

/**
 * Compares the SHA-256 recorded at install time with the one published for the latest release.
 * Works for every dependency (FFmpeg builds have no semver) and avoids the GitHub API rate limit.
 */
export async function checkUpdates(
  defs: DepDef[],
  binDir: string,
  fetchImpl: FetchLike,
): Promise<Partial<Record<DepId, boolean>>> {
  const db = await readInstalledDb(binDir);
  const result: Partial<Record<DepId, boolean>> = {};
  await Promise.all(
    defs.map(async (def) => {
      const rec = db[def.id];
      if (!rec) return;
      try {
        const latest = await fetchExpectedChecksum(def, fetchImpl);
        result[def.id] = latest !== rec.sha256 || rec.assetName !== def.assetName;
      } catch {
        /* offline: leave unknown */
      }
    }),
  );
  return result;
}

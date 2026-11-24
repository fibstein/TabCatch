import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import treeKill from 'tree-kill';
import type { RunHandle } from './downloader';

/** Spawns an executable and reports stdout + stderr line by line. */
export function spawnRunner(file: string, args: string[]): RunHandle {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const listeners: ((line: string) => void)[] = [];
  const emit = (line: string) => listeners.forEach((l) => l(line));
  createInterface({ input: child.stdout }).on('line', emit);
  createInterface({ input: child.stderr }).on('line', emit);
  const done = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  return {
    onLine: (cb) => listeners.push(cb),
    done,
    // yt-dlp starts ffmpeg as a child; kill the whole tree so nothing keeps the file locked.
    kill: () => {
      if (child.pid) treeKill(child.pid, 'SIGKILL');
    },
  };
}

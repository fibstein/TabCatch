export type DepId = 'yt-dlp' | 'ffmpeg' | 'deno';
export type ArchiveKind = 'none' | 'zip' | 'tar.xz';

export interface DepDef {
  id: DepId;
  label: string;
  reason: string;
  assetName: string;
  assetUrl: string;
  /** File listing the SHA-256 of the asset, published next to it in the same release. */
  checksumUrl: string;
  archive: ArchiveKind;
  /** Executables installed into the bin dir (basenames, looked up anywhere inside an archive). */
  files: string[];
  /** Executable + args used to check that the install works. */
  versionFile: string;
  versionArgs: string[];
  /** Updated without asking (yt-dlp has to follow site changes quickly). */
  autoUpdate: boolean;
}

const GH = 'https://github.com';

export function exe(base: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${base}.exe` : base;
}

/**
 * Windows is the target platform. The Linux entries exist so the dependency manager and the
 * downloader can be exercised in CI / dev containers.
 */
export function getDepDefs(platform: NodeJS.Platform = process.platform): DepDef[] {
  const win = platform === 'win32';
  const ytAsset = win ? 'yt-dlp.exe' : 'yt-dlp_linux';
  const ffAsset = win ? 'ffmpeg-master-latest-win64-gpl.zip' : 'ffmpeg-master-latest-linux64-gpl.tar.xz';
  const denoAsset = win ? 'deno-x86_64-pc-windows-msvc.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
  return [
    {
      id: 'yt-dlp',
      label: 'yt-dlp',
      reason: 'Video indirici',
      assetName: ytAsset,
      assetUrl: `${GH}/yt-dlp/yt-dlp/releases/latest/download/${ytAsset}`,
      checksumUrl: `${GH}/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS`,
      archive: 'none',
      files: [exe('yt-dlp', platform)],
      versionFile: exe('yt-dlp', platform),
      versionArgs: ['--version'],
      autoUpdate: true,
    },
    {
      id: 'ffmpeg',
      label: 'FFmpeg',
      reason: 'Ses+görüntü birleştirme, dosya onarımı ve doğrulama (ffprobe)',
      assetName: ffAsset,
      assetUrl: `${GH}/yt-dlp/FFmpeg-Builds/releases/download/latest/${ffAsset}`,
      checksumUrl: `${GH}/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256`,
      archive: win ? 'zip' : 'tar.xz',
      files: [exe('ffmpeg', platform), exe('ffprobe', platform)],
      versionFile: exe('ffmpeg', platform),
      versionArgs: ['-version'],
      autoUpdate: false,
    },
    {
      id: 'deno',
      label: 'Deno',
      reason: "YouTube'un JavaScript korumalarını çözmek için yt-dlp'nin önerdiği runtime",
      assetName: denoAsset,
      assetUrl: `${GH}/denoland/deno/releases/latest/download/${denoAsset}`,
      checksumUrl: `${GH}/denoland/deno/releases/latest/download/${denoAsset}.sha256sum`,
      archive: 'zip',
      files: [exe('deno', platform)],
      versionFile: exe('deno', platform),
      versionArgs: ['--version'],
      autoUpdate: false,
    },
  ];
}

/**
 * Supports both `sha256sum` style ("<hash>  <name>" per line) and the PowerShell
 * Get-FileHash output Deno publishes ("Hash : <HASH>").
 */
export function parseChecksum(text: string, assetName: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m && m[2] === assetName) return m[1].toLowerCase();
  }
  const all = text.match(/\b[0-9a-fA-F]{64}\b/g) ?? [];
  const unique = [...new Set(all.map((h) => h.toLowerCase()))];
  // A single hash with no file name only makes sense for a per-asset checksum file.
  if (unique.length === 1 && !lines.some((l) => /^[0-9a-fA-F]{64}\s+\S/.test(l))) return unique[0];
  return null;
}

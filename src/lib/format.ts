/**
 * Small, pure formatting helpers shared by the tester UI and the text report.
 * Nothing here touches the DOM, so it runs under `node --test` too.
 */

/** "24.6 MB" — binary units (1 KB = 1024 bytes), like Windows Explorer and macOS Finder's "KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Media clock: "02:34" or "1:02:34". NaN → "Unknown", Infinity → "Unknown (live/unbounded)". */
export function formatDuration(seconds: number): string {
  if (Number.isNaN(seconds)) return 'Unknown';
  if (!Number.isFinite(seconds)) return 'Unknown (not stored in file)';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Precise seconds for the playback trace: "1.02s". */
export const formatSeconds = (seconds: number) => (Number.isFinite(seconds) ? `${seconds.toFixed(2)}s` : String(seconds));

const COMMON_RATIOS: Array<[string, number]> = [
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['1:1', 1],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
  ['21:9', 64 / 27],
  ['1.85:1', 1.85],
  ['2.39:1', 2.39],
  ['5:4', 5 / 4],
  ['4:5', 4 / 5],
];

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * "16:9" for 1920×1080, "≈ 16:9" for 854×480, "1.43:1" for odd sizes.
 * Returns "—" when there is no picture (audio-only or not yet known).
 */
export function aspectRatio(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return '—';
  const d = gcd(width, height);
  const w = width / d;
  const h = height / d;
  const ratio = width / height;
  for (const [label] of COMMON_RATIOS) {
    if (label === `${w}:${h}`) return label;
  }
  for (const [label, value] of COMMON_RATIOS) {
    if (Math.abs(ratio - value) / value < 0.01) return `≈ ${label}`;
  }
  if (w <= 32 && h <= 32) return `${w}:${h}`;
  return `${ratio.toFixed(2)}:1`;
}

/** "mp4" from "Holiday.Clip.MP4"; "" when there is no extension. */
export function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unknown';
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const READY_STATES = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'] as const;
const READY_LABELS = ['No data', 'Metadata only', 'Current frame', 'Can play', 'Can play through'];

export const NETWORK_STATES = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'] as const;
const NETWORK_LABELS = ['Empty', 'Idle', 'Loading', 'No source'];

export const readyStateLabel = (n: number) => READY_LABELS[n] ?? `Unknown (${n})`;
export const networkStateLabel = (n: number) => NETWORK_LABELS[n] ?? `Unknown (${n})`;

/** Friendly browser name for the report. The raw UA is only shown in Technical Details. */
export function getBrowserName(ua: string): string {
  const match = (re: RegExp) => ua.match(re)?.[1]?.split('.')[0];
  let v: string | undefined;
  if ((v = match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) return `Microsoft Edge ${v}`;
  if ((v = match(/OPR\/([\d.]+)/))) return `Opera ${v}`;
  if ((v = match(/SamsungBrowser\/([\d.]+)/))) return `Samsung Internet ${v}`;
  if ((v = match(/Firefox\/([\d.]+)/)) || (v = match(/FxiOS\/([\d.]+)/))) return `Firefox ${v}`;
  if ((v = match(/CriOS\/([\d.]+)/))) return `Chrome (iOS) ${v}`;
  if ((v = match(/Chrome\/([\d.]+)/))) return `Chrome ${v}`;
  if ((v = match(/Version\/([\d.]+).*Safari/))) return `Safari ${v}`;
  return 'Unknown browser';
}

export function getOsName(ua: string): string {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS / iPadOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

/** `canPlayType()` answer in words. It's a hint about the *type*, never proof about a file. */
export function canPlayLabel(answer: string): string {
  if (answer === 'probably') return 'Probably';
  if (answer === 'maybe') return 'Maybe';
  return 'No';
}

/**
 * File handling: describing the selected file, reading its header locally and managing the
 * object URL the <video> element plays. The file never leaves the browser.
 */
import { formatBytes, formatDate, getExtension } from './format.ts';
import { HEAD_BYTES, inspectHeader, type HeaderInfo, type Reader } from './sniff.ts';

export interface FileInformation {
  name: string;
  extension: string;
  size: number;
  sizeLabel: string;
  /** MIME type as reported by the OS/browser. Often empty for MKV, AVI, etc. */
  reportedType: string;
  /** Best MIME type to show: the reported one, or a guess from the extension. */
  mimeType: string;
  mimeIsGuess: boolean;
  lastModified: number;
  lastModifiedLabel: string;
}

/** Common video extensions → MIME type. Unknown extensions are still tested. */
export const EXTENSION_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  mkv: 'video/x-matroska',
  mk3d: 'video/x-matroska',
  avi: 'video/x-msvideo',
  divx: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  m2v: 'video/mpeg',
  vob: 'video/mpeg',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  flv: 'video/x-flv',
  f4v: 'video/mp4',
  ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  rm: 'application/vnd.rn-realmedia',
  rmvb: 'application/vnd.rn-realmedia-vbr',
};

/** The `accept` hint for the file picker. It's only a hint — "All files" still works. */
export const ACCEPT = ['video/*', ...Object.keys(EXTENSION_MIME).map((ext) => `.${ext}`)].join(',');

export function getFileInformation(file: File): FileInformation {
  const extension = getExtension(file.name);
  const guess = EXTENSION_MIME[extension] ?? '';
  return {
    name: file.name,
    extension,
    size: file.size,
    sizeLabel: formatBytes(file.size),
    reportedType: file.type,
    mimeType: file.type || guess || 'Unknown',
    mimeIsGuess: !file.type && Boolean(guess),
    lastModified: file.lastModified,
    lastModifiedLabel: formatDate(file.lastModified),
  };
}

// ─── Object URLs ───────────────────────────────────────────────────────────────────────────

const liveUrls = new Set<string>();

/** A `blob:` URL that points at the local file. Nothing is uploaded — the URL only works in this tab. */
export function createVideoObjectURL(file: File): string {
  const url = URL.createObjectURL(file);
  liveUrls.add(url);
  return url;
}

export function revokeVideoObjectURL(url: string | null | undefined) {
  if (!url) return;
  URL.revokeObjectURL(url);
  liveUrls.delete(url);
}

/** How many object URLs this page currently holds (shown in Technical Details as a leak check). */
export const liveObjectUrlCount = () => liveUrls.size;

// ─── Header inspection ─────────────────────────────────────────────────────────────────────

async function readSlice(file: File, offset: number, length: number): Promise<Uint8Array> {
  const end = Math.min(file.size, offset + length);
  if (offset >= end) return new Uint8Array(0);
  return new Uint8Array(await file.slice(offset, end).arrayBuffer());
}

/**
 * Read the first megabyte and inspect it. Throws if the file can't be read at all
 * (moved, deleted, permission denied) — that's a real "file not loaded" failure.
 */
export async function readFileHeader(file: File, extension: string): Promise<HeaderInfo> {
  const head = await readSlice(file, 0, HEAD_BYTES);
  const read: Reader = (offset, length) =>
    offset + length <= head.length ? Promise.resolve(head.subarray(offset, offset + length)) : readSlice(file, offset, length);
  return inspectHeader(head, file.size, read, extension);
}

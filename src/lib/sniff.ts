/**
 * A tiny, defensive file-header inspector. It reads a few bytes of the selected file (locally —
 * nothing leaves the browser) to name the container and, where cheap, the codecs inside.
 *
 * This is only used to *explain* results. The pass/fail verdict always comes from the browser
 * actually loading and playing the file. Every read is bounded and every parse step is guarded,
 * so a hostile or damaged file can at worst produce "Unknown".
 */

export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

export type Family =
  | 'mp4'
  | 'matroska'
  | 'avi'
  | 'asf'
  | 'mpeg-ps'
  | 'mpeg-ts'
  | 'ogg'
  | 'flv'
  | 'realmedia'
  | 'audio'
  | 'not-video'
  | 'empty'
  | 'unknown';

export interface TrackHint {
  kind: 'video' | 'audio' | 'other';
  /** Raw identifier found in the file, e.g. "avc1", "V_VP9", "XVID". */
  id: string;
  /** Human name, e.g. "H.264 / AVC". */
  name: string;
  /** Codec string for `canPlayType()`, when there is a sensible one. */
  codecs?: string;
}

export interface HeaderInfo {
  family: Family;
  /** Human container name, e.g. "MP4", "QuickTime (MOV)", "WebM". */
  container: string;
  /** MIME type for `canPlayType()` hints, when known. */
  mime: string | null;
  /** ftyp major brand / Matroska DocType. */
  brand?: string;
  tracks: TrackHint[];
  /** Strong structural evidence that the file is damaged or incomplete. */
  problems: string[];
  /** Neutral observations worth showing (e.g. extension mismatch). */
  notes: string[];
}

export const HEAD_BYTES = 1024 * 1024;

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const startsWith = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v);
const isFourcc = (s: string) => /^[\x20-\x7e]{4}$/.test(s);

/** 64-bit big-endian size as a JS number (safe up to 8 PB — plenty for a local file). */
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);

// ─── Codec tables ──────────────────────────────────────────────────────────────────────────

const MP4_VIDEO: Record<string, [string, string?]> = {
  avc1: ['H.264 / AVC', 'avc1.640028'],
  avc3: ['H.264 / AVC', 'avc3.640028'],
  hvc1: ['H.265 / HEVC', 'hvc1.1.6.L93.B0'],
  hev1: ['H.265 / HEVC', 'hev1.1.6.L93.B0'],
  dvh1: ['Dolby Vision (HEVC)', 'dvh1.05.06'],
  dvhe: ['Dolby Vision (HEVC)', 'dvhe.05.06'],
  dva1: ['Dolby Vision (AVC)', 'dva1.09.06'],
  dvav: ['Dolby Vision (AVC)', 'dvav.09.06'],
  av01: ['AV1', 'av01.0.08M.08'],
  vp09: ['VP9', 'vp09.00.40.08'],
  vp08: ['VP8', 'vp8'],
  mp4v: ['MPEG-4 Part 2 (DivX/Xvid style)', 'mp4v.20.8'],
  s263: ['H.263'],
  h263: ['H.263'],
  vvc1: ['H.266 / VVC'],
  vvi1: ['H.266 / VVC'],
  jpeg: ['Motion JPEG'],
  mjpa: ['Motion JPEG'],
  mjpb: ['Motion JPEG'],
  apch: ['Apple ProRes 422 HQ'],
  apcn: ['Apple ProRes 422'],
  apcs: ['Apple ProRes 422 LT'],
  apco: ['Apple ProRes 422 Proxy'],
  ap4h: ['Apple ProRes 4444'],
  ap4x: ['Apple ProRes 4444 XQ'],
  'dvc ': ['DV'],
  dvcp: ['DV'],
  dv5n: ['DVCPRO 50'],
  'raw ': ['Uncompressed video'],
  encv: ['Encrypted video (DRM protected)'],
};

const MP4_AUDIO: Record<string, [string, string?]> = {
  mp4a: ['AAC (MPEG-4 audio)', 'mp4a.40.2'],
  Opus: ['Opus', 'opus'],
  fLaC: ['FLAC', 'flac'],
  '.mp3': ['MP3', 'mp3'],
  'ac-3': ['Dolby Digital (AC-3)', 'ac-3'],
  'ec-3': ['Dolby Digital Plus (E-AC-3)', 'ec-3'],
  'ac-4': ['Dolby AC-4', 'ac-4'],
  alac: ['Apple Lossless (ALAC)', 'alac'],
  samr: ['AMR-NB'],
  sawb: ['AMR-WB'],
  sowt: ['PCM (uncompressed)'],
  twos: ['PCM (uncompressed)'],
  lpcm: ['PCM (uncompressed)'],
  ipcm: ['PCM (uncompressed)'],
  in24: ['PCM (uncompressed)'],
  fl32: ['PCM (uncompressed)'],
  dtsc: ['DTS'],
  dtsh: ['DTS-HD'],
  dtsl: ['DTS-HD MA'],
  enca: ['Encrypted audio (DRM protected)'],
};

const HANDLER_NAMES: Record<string, string> = {
  text: 'Text / subtitles',
  sbtl: 'Subtitles',
  subt: 'Subtitles',
  clcp: 'Closed captions',
  tmcd: 'Timecode',
  meta: 'Metadata',
  hint: 'Streaming hints',
};

const MKV_CODECS: Array<[RegExp, TrackHint['kind'], string, string?]> = [
  [/^V_VP8$/, 'video', 'VP8', 'vp8'],
  [/^V_VP9$/, 'video', 'VP9', 'vp9'],
  [/^V_AV1$/, 'video', 'AV1', 'av01.0.08M.08'],
  [/^V_MPEG4\/ISO\/AVC$/, 'video', 'H.264 / AVC', 'avc1.640028'],
  [/^V_MPEGH\/ISO\/HEVC$/, 'video', 'H.265 / HEVC', 'hvc1.1.6.L93.B0'],
  [/^V_MPEG4\/ISO\//, 'video', 'MPEG-4 Part 2 (DivX/Xvid style)', 'mp4v.20.8'],
  [/^V_MPEG4\/MS\/V3$/, 'video', 'Microsoft MPEG-4 v3 (DivX 3)'],
  [/^V_MPEG2$/, 'video', 'MPEG-2 video'],
  [/^V_MPEG1$/, 'video', 'MPEG-1 video'],
  [/^V_THEORA$/, 'video', 'Theora', 'theora'],
  [/^V_MJPEG$/, 'video', 'Motion JPEG'],
  [/^V_PRORES$/, 'video', 'Apple ProRes'],
  [/^V_MS\/VFW/, 'video', 'Video for Windows codec (AVI-style)'],
  [/^V_UNCOMPRESSED$/, 'video', 'Uncompressed video'],
  [/^V_/, 'video', 'Other video codec'],
  [/^A_OPUS$/, 'audio', 'Opus', 'opus'],
  [/^A_VORBIS$/, 'audio', 'Vorbis', 'vorbis'],
  [/^A_AAC/, 'audio', 'AAC', 'mp4a.40.2'],
  [/^A_MPEG\/L3$/, 'audio', 'MP3', 'mp3'],
  [/^A_MPEG\/L2$/, 'audio', 'MPEG-1 Audio Layer II'],
  [/^A_AC3$/, 'audio', 'Dolby Digital (AC-3)', 'ac-3'],
  [/^A_EAC3$/, 'audio', 'Dolby Digital Plus (E-AC-3)', 'ec-3'],
  [/^A_DTS/, 'audio', 'DTS'],
  [/^A_TRUEHD$/, 'audio', 'Dolby TrueHD'],
  [/^A_FLAC$/, 'audio', 'FLAC', 'flac'],
  [/^A_PCM/, 'audio', 'PCM (uncompressed)'],
  [/^A_/, 'audio', 'Other audio codec'],
];

const AVI_VIDEO: Record<string, string> = {
  XVID: 'MPEG-4 Part 2 (Xvid)',
  DIVX: 'MPEG-4 Part 2 (DivX)',
  DX50: 'MPEG-4 Part 2 (DivX 5)',
  FMP4: 'MPEG-4 Part 2',
  MP4V: 'MPEG-4 Part 2',
  DIV3: 'Microsoft MPEG-4 v3 (DivX 3)',
  MP43: 'Microsoft MPEG-4 v3',
  MP42: 'Microsoft MPEG-4 v2',
  H264: 'H.264 / AVC',
  X264: 'H.264 / AVC',
  AVC1: 'H.264 / AVC',
  HEVC: 'H.265 / HEVC',
  H265: 'H.265 / HEVC',
  HVC1: 'H.265 / HEVC',
  MJPG: 'Motion JPEG',
  WMV3: 'Windows Media Video 9',
  WVC1: 'VC-1',
  MPG2: 'MPEG-2 video',
  DVSD: 'DV',
  CVID: 'Cinepak',
  IV50: 'Intel Indeo 5',
};

const WAVE_FORMATS: Record<number, string> = {
  0x0001: 'PCM (uncompressed)',
  0x0002: 'Microsoft ADPCM',
  0x0011: 'IMA ADPCM',
  0x0050: 'MPEG-1 Audio Layer I/II',
  0x0055: 'MP3',
  0x00ff: 'AAC',
  0x0161: 'Windows Media Audio',
  0x1610: 'AAC',
  0x2000: 'Dolby Digital (AC-3)',
  0x2001: 'DTS',
};

/** Extension → the family a file with that extension normally is. Used only for a friendly note. */
const EXT_FAMILY: Record<string, Family> = {
  mp4: 'mp4', m4v: 'mp4', mov: 'mp4', qt: 'mp4', '3gp': 'mp4', '3g2': 'mp4', f4v: 'mp4',
  mkv: 'matroska', webm: 'matroska', mk3d: 'matroska',
  avi: 'avi', divx: 'avi',
  wmv: 'asf', asf: 'asf',
  mpg: 'mpeg-ps', mpeg: 'mpeg-ps', vob: 'mpeg-ps', m2v: 'mpeg-ps',
  ts: 'mpeg-ts', mts: 'mpeg-ts', m2ts: 'mpeg-ts',
  ogv: 'ogg', ogg: 'ogg',
  flv: 'flv',
  rm: 'realmedia', rmvb: 'realmedia',
};

const FAMILY_NAMES: Partial<Record<Family, string>> = {
  mp4: 'MP4/MOV',
  matroska: 'Matroska/WebM',
  avi: 'AVI',
  asf: 'ASF/WMV',
  'mpeg-ps': 'MPEG program stream',
  'mpeg-ts': 'MPEG transport stream',
  ogg: 'Ogg',
  flv: 'Flash Video',
  realmedia: 'RealMedia',
};

// ─── Entry point ───────────────────────────────────────────────────────────────────────────

/**
 * Inspect a file's header. `head` is the first min(size, HEAD_BYTES) bytes; `read` fetches other
 * ranges on demand (used to walk MP4 boxes that live past the head, e.g. a trailing `moov`).
 */
export async function inspectHeader(head: Uint8Array, size: number, read: Reader, extension = ''): Promise<HeaderInfo> {
  const info: HeaderInfo = { family: 'unknown', container: 'Unknown', mime: null, tracks: [], problems: [], notes: [] };

  if (size === 0) {
    info.family = 'empty';
    info.container = 'Empty file';
    info.problems.push('The file is empty (0 bytes).');
    return info;
  }

  identify(head, size, info);

  try {
    if (info.family === 'mp4') await inspectMp4(size, read, info);
    else if (info.family === 'matroska') inspectMatroska(head, info);
    else if (info.family === 'avi') inspectAvi(head, info);
    else if (info.family === 'asf') inspectAsf(head, info);
    else if (info.family === 'ogg') inspectOgg(head, info);
    else if (info.family === 'flv') inspectFlv(head, info);
  } catch {
    info.notes.push('The file header could not be fully inspected.');
  }

  const expected = EXT_FAMILY[extension];
  if (expected && FAMILY_NAMES[info.family] && expected !== info.family) {
    info.notes.push(
      `The extension is .${extension}, but the content is ${FAMILY_NAMES[info.family]}. Browsers go by the content, so the extension alone is misleading here.`,
    );
  }
  return info;
}

// ─── Signatures ────────────────────────────────────────────────────────────────────────────

function identify(b: Uint8Array, size: number, info: HeaderInfo) {
  const set = (family: Family, container: string, mime: string | null) => {
    info.family = family;
    info.container = container;
    info.mime = mime;
  };
  const type4 = b.length >= 8 ? ascii(b, 4, 4) : '';

  if (type4 === 'ftyp' && b.length >= 12) {
    const brand = ascii(b, 8, 4);
    info.brand = brand.trim();
    if (brand === 'qt  ') return set('mp4', 'QuickTime (MOV)', 'video/quicktime');
    if (brand.startsWith('3gp') || brand.startsWith('3ge') || brand.startsWith('3gg')) return set('mp4', '3GP', 'video/3gpp');
    if (brand.startsWith('3g2')) return set('mp4', '3GPP2 (3G2)', 'video/3gpp2');
    if (brand.startsWith('M4V')) return set('mp4', 'M4V (Apple MPEG-4)', 'video/mp4');
    if (brand === 'M4A ' || brand === 'M4B ') return set('audio', 'M4A audio', 'audio/mp4');
    if (['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(brand)) return set('not-video', 'AVIF/HEIF image', null);
    if (brand === 'crx ') return set('not-video', 'Canon RAW photo', null);
    return set('mp4', 'MP4', 'video/mp4');
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(type4)) return set('mp4', 'QuickTime (MOV)', 'video/quicktime');
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    const doc = latin1(b.subarray(0, 64)).includes('webm');
    info.brand = doc ? 'webm' : 'matroska';
    return doc ? set('matroska', 'WebM', 'video/webm') : set('matroska', 'Matroska (MKV)', 'video/x-matroska');
  }
  if (ascii(b, 0, 4) === 'RIFF') {
    const form = ascii(b, 8, 4);
    if (form === 'AVI ' || form === 'AVIX') return set('avi', 'AVI', 'video/x-msvideo');
    if (form === 'WAVE') return set('audio', 'WAV audio', 'audio/wav');
    if (form === 'WEBP') return set('not-video', 'WebP image', null);
    return set('unknown', `RIFF (${form.trim() || 'unknown'})`, null);
  }
  if (startsWith(b, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) {
    return set('asf', 'ASF (Windows Media)', 'video/x-ms-wmv');
  }
  if (startsWith(b, [0x00, 0x00, 0x01, 0xba])) return set('mpeg-ps', 'MPEG program stream (MPG)', 'video/mpeg');
  if (startsWith(b, [0x00, 0x00, 0x01, 0xb3])) return set('mpeg-ps', 'MPEG video elementary stream', 'video/mpeg');
  if (ascii(b, 0, 4) === 'GIF8') return set('not-video', 'GIF image', null);
  if (b[0] === 0x47 && (size <= 188 || b[188] === 0x47)) return set('mpeg-ts', 'MPEG transport stream (TS)', 'video/mp2t');
  if (b[4] === 0x47 && (size <= 196 || b[196] === 0x47)) return set('mpeg-ts', 'MPEG transport stream (M2TS)', 'video/mp2t');
  if (ascii(b, 0, 4) === 'OggS') return set('ogg', 'Ogg', 'video/ogg');
  if (ascii(b, 0, 3) === 'FLV') return set('flv', 'Flash Video (FLV)', 'video/x-flv');
  if (ascii(b, 0, 4) === '.RMF') return set('realmedia', 'RealMedia', 'application/vnd.rn-realmedia');

  // Things that are clearly not video.
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return set('audio', 'MP3/AAC audio', 'audio/mpeg');
  if (ascii(b, 0, 4) === 'fLaC') return set('audio', 'FLAC audio', 'audio/flac');
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return set('not-video', 'PNG image', null);
  if (startsWith(b, [0xff, 0xd8, 0xff])) return set('not-video', 'JPEG image', null);
  if (ascii(b, 0, 4) === '%PDF') return set('not-video', 'PDF document', null);
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return set('not-video', 'ZIP archive', null);
  if (ascii(b, 0, 4) === 'Rar!') return set('not-video', 'RAR archive', null);
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf])) return set('not-video', '7-Zip archive', null);
  if (ascii(b, 0, 2) === 'MZ') return set('not-video', 'Windows program', null);
  if (looksLikeText(b)) return set('not-video', 'Text document', null);
  if (b.subarray(0, Math.min(b.length, 4096)).every((x) => x === 0)) {
    info.problems.push('The start of the file is all zero bytes. The data may be missing or overwritten.');
    return set('unknown', 'Unknown (blank data)', null);
  }
}

function looksLikeText(b: Uint8Array) {
  const n = Math.min(b.length, 512);
  if (n < 16) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2) printable++;
  }
  return printable / n > 0.97;
}

// ─── MP4 / MOV ─────────────────────────────────────────────────────────────────────────────

interface Box {
  type: string;
  /** Offset of the box payload (after the header). */
  start: number;
  /** End of the box, clamped to the parent/file. */
  end: number;
  /** End the box *claims*, which can be past the file end when truncated. */
  claimedEnd: number;
}

async function* boxes(read: Reader, start: number, end: number, limit = 256): AsyncGenerator<Box> {
  let offset = start;
  for (let i = 0; i < limit && offset + 8 <= end; i++) {
    const h = await read(offset, 16);
    if (h.length < 8) return;
    let size = u32(h, 0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (!isFourcc(type)) return;
    if (size === 1) {
      if (h.length < 16) return;
      size = u64(h, 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) return;
    yield { type, start: offset + header, end: Math.min(offset + size, end), claimedEnd: offset + size };
    offset += size;
  }
}

async function inspectMp4(size: number, read: Reader, info: HeaderInfo) {
  let moov: Box | null = null;
  let covered = 0;

  for await (const box of boxes(read, 0, size)) {
    covered = box.end;
    if (box.claimedEnd > size) {
      const missing = box.claimedEnd - size;
      info.problems.push(
        `The file looks truncated: its '${box.type}' section needs ${missing.toLocaleString()} more bytes than the file contains. This usually means an incomplete download, copy or recording.`,
      );
    }
    if (box.type === 'moov') moov = box;
  }

  if (covered < size && covered > 0 && size - covered >= 8) {
    info.notes.push(`Unrecognised data after byte ${covered.toLocaleString()} (the rest of the file is not valid MP4 structure).`);
  }

  if (!moov) {
    info.problems.push(
      "The MP4 index ('moov' box) is missing. Without it a player cannot find the video frames. This typically happens when a recording was interrupted or the file was not fully copied.",
    );
    return;
  }
  for await (const trak of boxes(read, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const track = await inspectTrak(read, trak);
    if (track) info.tracks.push(track);
    if (info.tracks.length >= 8) break;
  }
}

async function inspectTrak(read: Reader, trak: Box): Promise<TrackHint | null> {
  let handler = '';
  let format = '';
  for await (const mdia of boxes(read, trak.start, trak.end)) {
    if (mdia.type !== 'mdia') continue;
    for await (const child of boxes(read, mdia.start, mdia.end)) {
      if (child.type === 'hdlr') {
        const h = await read(child.start, 12);
        handler = h.length >= 12 ? ascii(h, 8, 4) : '';
      } else if (child.type === 'minf') {
        for await (const stbl of boxes(read, child.start, child.end)) {
          if (stbl.type !== 'stbl') continue;
          for await (const stsd of boxes(read, stbl.start, stbl.end)) {
            if (stsd.type !== 'stsd') continue;
            // FullBox (4) + entry_count (4) + first entry: size (4) + format (4)
            const s = await read(stsd.start, 16);
            if (s.length >= 16 && u32(s, 4) > 0) format = ascii(s, 12, 4);
          }
        }
      }
    }
  }
  if (!format) return null;
  const kind: TrackHint['kind'] = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : MP4_VIDEO[format] ? 'video' : MP4_AUDIO[format] ? 'audio' : 'other';
  const table = kind === 'video' ? MP4_VIDEO : kind === 'audio' ? MP4_AUDIO : {};
  const entry = table[format];
  const name = entry?.[0] ?? (kind === 'other' ? HANDLER_NAMES[handler] ?? `Other (${handler || format})` : `Unknown (${format.trim()})`);
  return { kind, id: format, name, codecs: entry?.[1] };
}

// ─── Other containers (best-effort string scans over the head) ─────────────────────────────

function inspectMatroska(head: Uint8Array, info: HeaderInfo) {
  const text = latin1(head);
  // CodecID element: 0x86, a one-byte size (0x80 | length), then the ASCII codec ID.
  const re = /\x86([\x81-\xbf])([VA]_[\x20-\x7e]*)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && info.tracks.length < 8) {
    const id = m[2].slice(0, m[1].charCodeAt(0) & 0x7f);
    if (!/^[VA]_[A-Z0-9_/.]+$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    const hit = MKV_CODECS.find(([pattern]) => pattern.test(id));
    if (hit) info.tracks.push({ kind: hit[1], id, name: hit[2], codecs: hit[3] });
  }
}

function inspectAvi(head: Uint8Array, info: HeaderInfo) {
  const text = latin1(head);
  let from = 0;
  for (let i = 0; i < 8; i++) {
    const at = text.indexOf('strh', from);
    if (at < 0 || at + 16 > head.length) break;
    from = at + 4;
    const type = text.slice(at + 8, at + 12);
    const handler = text.slice(at + 12, at + 16);
    const strf = text.indexOf('strf', at);
    if (type === 'vids') {
      // BITMAPINFOHEADER.biCompression is the most reliable codec tag.
      const compression = strf > 0 && strf + 28 <= head.length ? text.slice(strf + 24, strf + 28) : '';
      const tag = [compression, handler].find((t) => isFourcc(t) && t.trim()) ?? '';
      const key = tag.toUpperCase().trim();
      info.tracks.push({ kind: 'video', id: tag || '?', name: AVI_VIDEO[key] ?? (key ? `Unknown (${key})` : 'Uncompressed video') });
    } else if (type === 'auds') {
      const tag = strf > 0 && strf + 10 <= head.length ? u16le(head, strf + 8) : -1;
      info.tracks.push({ kind: 'audio', id: tag >= 0 ? `0x${tag.toString(16).padStart(4, '0')}` : '?', name: WAVE_FORMATS[tag] ?? 'Unknown audio' });
    }
  }
}

function inspectAsf(head: Uint8Array, info: HeaderInfo) {
  const text = latin1(head);
  for (const [tag, name] of [
    ['WMV3', 'Windows Media Video 9'],
    ['WMV2', 'Windows Media Video 8'],
    ['WMV1', 'Windows Media Video 7'],
    ['WVC1', 'VC-1'],
    ['WMVA', 'VC-1 (Advanced)'],
    ['MP43', 'Microsoft MPEG-4 v3'],
    ['H264', 'H.264 / AVC'],
  ] as const) {
    if (text.includes(tag)) {
      info.tracks.push({ kind: 'video', id: tag, name });
      break;
    }
  }
}

function inspectOgg(head: Uint8Array, info: HeaderInfo) {
  const text = latin1(head);
  if (text.includes('\x80theora')) info.tracks.push({ kind: 'video', id: 'theora', name: 'Theora', codecs: 'theora' });
  if (text.includes('OVP80')) info.tracks.push({ kind: 'video', id: 'VP8', name: 'VP8', codecs: 'vp8' });
  if (text.includes('\x01vorbis')) info.tracks.push({ kind: 'audio', id: 'vorbis', name: 'Vorbis', codecs: 'vorbis' });
  if (text.includes('OpusHead')) info.tracks.push({ kind: 'audio', id: 'opus', name: 'Opus', codecs: 'opus' });
  if (text.includes('\x7fFLAC')) info.tracks.push({ kind: 'audio', id: 'flac', name: 'FLAC', codecs: 'flac' });
  if (!info.tracks.some((t) => t.kind === 'video')) info.notes.push('No video stream was found in the Ogg header; it may be audio-only.');
}

function inspectFlv(head: Uint8Array, info: HeaderInfo) {
  if (head.length < 5) return;
  const flags = head[4];
  if (flags & 0x01) info.tracks.push({ kind: 'video', id: 'flv', name: 'Flash video stream' });
  if (flags & 0x04) info.tracks.push({ kind: 'audio', id: 'flv', name: 'Flash audio stream' });
}

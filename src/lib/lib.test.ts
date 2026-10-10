/**
 * Unit tests for the DOM-free logic: `npm test` (node --test, TypeScript via type stripping).
 * The browser-level behaviour (load/decode/play) is verified in a real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatio, formatBytes, formatDuration, getBrowserName, getExtension } from './format.ts';
import { inspectHeader, type Reader } from './sniff.ts';
import { classifyPlayError, diagnoseLoadFailure, diagnosePlayFailure, MESSAGES } from './media-errors.ts';
import { generateTestReport } from './report.ts';
import { emptyState } from './video-test.ts';

// ─── Helpers to build tiny MP4s ────────────────────────────────────────────────────────────

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...be32(8 + body.length), ...enc(type), ...body];
}
const ftyp = (brand = 'isom') => box('ftyp', enc(brand), be32(512), enc('isomavc1'));
const hdlr = (handler: string) => box('hdlr', be32(0), be32(0), enc(handler), be32(0), be32(0), be32(0), [0]);
const stsd = (format: string) => box('stsd', be32(0), be32(1), box(format, new Array(8).fill(0)));
const trak = (handler: string, format: string) => box('trak', box('mdia', hdlr(handler), box('minf', box('stbl', stsd(format)))));

async function inspect(bytes: number[], ext = 'mp4') {
  const data = Uint8Array.from(bytes);
  const read: Reader = async (o, n) => data.subarray(o, o + n);
  return inspectHeader(data.subarray(0, 1024 * 1024), data.length, read, ext);
}

// ─── format.ts ─────────────────────────────────────────────────────────────────────────────

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(24.6 * 1024 * 1024), '24.6 MB');
  assert.equal(formatBytes(NaN), 'Unknown');
});

test('formatDuration', () => {
  assert.equal(formatDuration(154), '02:34');
  assert.equal(formatDuration(3754.9), '1:02:34');
  assert.equal(formatDuration(NaN), 'Unknown');
  assert.match(formatDuration(Infinity), /^Unknown/);
});

test('aspectRatio', () => {
  assert.equal(aspectRatio(1920, 1080), '16:9');
  assert.equal(aspectRatio(1080, 1920), '9:16');
  assert.equal(aspectRatio(640, 480), '4:3');
  assert.equal(aspectRatio(854, 480), '≈ 16:9');
  assert.equal(aspectRatio(0, 0), '—');
});

test('getExtension / getBrowserName', () => {
  assert.equal(getExtension('Holiday.Clip.MP4'), 'mp4');
  assert.equal(getExtension('.hidden'), '');
  assert.equal(getExtension('noext'), '');
  assert.match(getBrowserName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), /^Microsoft Edge 140/);
  assert.match(getBrowserName('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'), /^Firefox 143/);
});

// ─── sniff.ts ──────────────────────────────────────────────────────────────────────────────

test('MP4 with H.264 + AAC tracks', async () => {
  const bytes = [...ftyp(), ...box('moov', trak('vide', 'avc1'), trak('soun', 'mp4a')), ...box('mdat', new Array(64).fill(1))];
  const info = await inspect(bytes);
  assert.equal(info.family, 'mp4');
  assert.equal(info.container, 'MP4');
  assert.deepEqual(info.tracks.map((t) => [t.kind, t.id]), [['video', 'avc1'], ['audio', 'mp4a']]);
  assert.equal(info.problems.length, 0);
});

test('MP4 with moov after mdat (not faststart) is still inspected', async () => {
  const bytes = [...ftyp(), ...box('mdat', new Array(200).fill(7)), ...box('moov', trak('vide', 'hvc1'))];
  const info = await inspect(bytes);
  assert.equal(info.tracks[0].name, 'H.265 / HEVC');
});

test('MP4 missing its moov box is reported as a structural problem', async () => {
  const info = await inspect([...ftyp(), ...box('mdat', new Array(100).fill(1))]);
  assert.equal(info.family, 'mp4');
  assert.ok(info.problems.some((p) => /moov/.test(p)));
});

test('truncated MP4 is detected', async () => {
  const full = [...ftyp(), ...box('moov', trak('vide', 'avc1')), ...box('mdat', new Array(1000).fill(1))];
  const info = await inspect(full.slice(0, full.length - 500));
  assert.ok(info.problems.some((p) => /truncated/.test(p)));
});

test('QuickTime brand and extension mismatch note', async () => {
  const info = await inspect([...ftyp('qt  '), ...box('moov', trak('vide', 'apcn'))], 'avi');
  assert.equal(info.container, 'QuickTime (MOV)');
  assert.equal(info.tracks[0].name, 'Apple ProRes 422');
  assert.ok(info.notes.some((n) => /extension is \.avi/.test(n)));
});

test('WebM codec ids', async () => {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...enc('webm')];
  const codec = (id: string) => [0x86, 0x80 | id.length, ...enc(id)];
  const info = await inspect([...ebml, ...new Array(20).fill(0), ...codec('V_VP9'), 0, 0, ...codec('A_OPUS')], 'webm');
  assert.equal(info.container, 'WebM');
  assert.deepEqual(info.tracks.map((t) => t.name), ['VP9', 'Opus']);
});

test('AVI stream headers', async () => {
  const bytes = [...enc('RIFF'), 0, 0, 0, 0, ...enc('AVI LIST'), 0, 0, 0, 0, ...enc('strh'), 56, 0, 0, 0, ...enc('vidsXVID'), ...new Array(48).fill(0), ...enc('strf'), 40, 0, 0, 0, 40, 0, 0, 0, ...new Array(12).fill(0), ...enc('XVID')];
  const info = await inspect(bytes, 'avi');
  assert.equal(info.family, 'avi');
  assert.equal(info.tracks[0].name, 'MPEG-4 Part 2 (Xvid)');
});

test('non-video and empty files', async () => {
  assert.equal((await inspect([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...new Array(20).fill(0)], 'mp4')).container, 'PNG image');
  assert.equal((await inspect(enc('<!doctype html><html><head><title>Not a video</title></head></html>'), 'mp4')).container, 'Text document');
  const empty = await inspectHeader(new Uint8Array(0), 0, async () => new Uint8Array(0), 'mp4');
  assert.equal(empty.family, 'empty');
});

// ─── media-errors.ts ───────────────────────────────────────────────────────────────────────

const chromeLike = (type: string) => (/x-msvideo|x-ms-wmv|mpeg"?$|x-flv|hvc1|hev1/.test(type) ? '' : 'probably');

test('play() rejections are classified', () => {
  const blocked = Object.assign(new Error('play() failed because the user didn’t interact'), { name: 'NotAllowedError' });
  assert.equal(classifyPlayError(blocked).kind, 'autoplay');
  const d = diagnosePlayFailure(classifyPlayError(blocked), null, chromeLike);
  assert.equal(d.severity, 'warn');
  assert.equal(d.message, MESSAGES.autoplay);
  const unsupported = Object.assign(new Error('x'), { name: 'NotSupportedError' });
  assert.equal(diagnosePlayFailure(classifyPlayError(unsupported), null, chromeLike).message, MESSAGES.unsupported);
  assert.equal(diagnosePlayFailure(classifyPlayError(new Error('boom')), null, chromeLike).message, MESSAGES.playback);
});

test('load failure: AVI is "unsupported", not "corrupted"', async () => {
  const header = await inspect([...enc('RIFF'), 0, 0, 0, 0, ...enc('AVI '), ...new Array(40).fill(0)], 'avi');
  const d = diagnoseLoadFailure({ code: 4, header, canPlay: chromeLike, metadataLoaded: false });
  assert.equal(d.kind, 'unsupported');
  assert.ok(d.hints.some((h) => /not supported by web browsers/.test(h)));
});

test('load failure: HEVC MP4 explains the codec', async () => {
  const header = await inspect([...ftyp(), ...box('moov', trak('vide', 'hvc1'), trak('soun', 'mp4a'))]);
  const d = diagnoseLoadFailure({ code: 4, header, canPlay: chromeLike, metadataLoaded: false });
  assert.equal(d.message, MESSAGES.unsupported);
  assert.ok(d.hints.some((h) => /HEVC/.test(h)));
});

test('load failure: MP4 without moov is "may be corrupted"', async () => {
  const header = await inspect([...ftyp(), ...box('mdat', new Array(100).fill(1))]);
  const d = diagnoseLoadFailure({ code: 4, header, canPlay: chromeLike, metadataLoaded: false });
  assert.equal(d.kind, 'corrupted');
  assert.equal(d.message, MESSAGES.corrupted);
});

test('load failure: supported container + codecs → likely damage, hedged', async () => {
  const header = await inspect([...ftyp(), ...box('moov', trak('vide', 'avc1')), ...box('mdat', [1, 2, 3])]);
  const d = diagnoseLoadFailure({ code: 4, header, canPlay: chromeLike, metadataLoaded: false });
  assert.equal(d.kind, 'corrupted');
  assert.ok(d.hints.some((h) => /can't be confirmed/.test(h)));
});

test('load failure: text file renamed .mp4', async () => {
  const header = await inspect(enc('This is definitely not a video file, just some text.'), 'mp4');
  const d = diagnoseLoadFailure({ code: 4, header, canPlay: chromeLike, metadataLoaded: false });
  assert.equal(d.kind, 'not-video');
});

test('load failure: unreadable file (MEDIA_ERR_NETWORK)', () => {
  assert.equal(diagnoseLoadFailure({ code: 2, header: null, canPlay: chromeLike, metadataLoaded: false }).kind, 'unreadable');
});

// ─── report.ts ─────────────────────────────────────────────────────────────────────────────

test('report contains the essentials', () => {
  const state = emptyState();
  state.file = {
    name: 'sample.mp4',
    extension: 'mp4',
    size: 25794969,
    sizeLabel: '24.6 MB',
    reportedType: 'video/mp4',
    mimeType: 'video/mp4',
    mimeIsGuess: false,
    lastModified: 0,
    lastModifiedLabel: 'Unknown',
  };
  state.metadata = { duration: 154, width: 1920, height: 1080, aspect: '16:9', hasVideo: true };
  state.checks.metadata = { status: 'pass', detail: '' };
  state.checks.decode = { status: 'pass', detail: '' };
  state.checks.playback = { status: 'pass', detail: '' };
  state.verdict = 'playable';
  const text = generateTestReport(state, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36', now: new Date(0) });
  for (const line of ['Video File Test Report', 'File: sample.mp4', 'Size: 24.6 MB', 'Type: video/mp4', 'Duration: 02:34', 'Resolution: 1920x1080', 'Metadata: PASS', 'Video data: PASS', 'Playback: PASS', 'Result: Video is playable', 'Browser: Chrome 140 on Windows']) {
    assert.ok(text.includes(line), `missing "${line}"\n${text}`);
  }
});

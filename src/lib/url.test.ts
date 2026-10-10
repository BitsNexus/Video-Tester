/** Unit tests for the URL checker's pure logic (`npm test`). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUrl, computeUrlVerdict, diagnoseUrlFailure, emptyUrlState, type UrlInfo } from './url-test.ts';
import { generateUrlReport } from './report.ts';

const info = (raw: string): UrlInfo => {
  const r = analyzeUrl(raw);
  assert.ok(r.ok, `expected ${raw} to parse`);
  return r.info;
};
const noHls = (type: string) => (type.includes('mpegurl') ? '' : 'probably');

test('analyzeUrl: direct files, streams and scheme-less input', () => {
  const mp4 = info('https://cdn.example.com/videos/clip.MP4?v=2');
  assert.equal(mp4.kind, 'file');
  assert.equal(mp4.format, 'MP4 video file');
  assert.equal(mp4.host, 'cdn.example.com');
  assert.equal(info('example.com/a/b.webm').href, 'https://example.com/a/b.webm');
  assert.equal(info('https://x.test/live/index.m3u8').kind, 'hls');
  assert.equal(info('https://x.test/manifest.mpd').kind, 'dash');
  assert.equal(info('https://x.test/stream').kind, 'unknown');
});

test('analyzeUrl: rejects non-web schemes and credentials', () => {
  for (const bad of ['', 'not a url', 'file:///C:/video.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'ftp://x.test/a.mp4', 'https://user:pw@x.test/a.mp4']) {
    const r = analyzeUrl(bad);
    assert.equal(r.ok, false, bad);
  }
  const f = analyzeUrl('file:///C:/video.mp4');
  assert.ok(!f.ok && /Video file/.test(f.error));
});

test('analyzeUrl: known video sites and host advice', () => {
  const yt = info('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(yt.kind, 'page');
  assert.equal(yt.site, 'YouTube');
  assert.equal(info('https://youtu.be/dQw4w9WgXcQ').site, 'YouTube');
  assert.ok(info('https://www.dropbox.com/s/abc/clip.mp4?dl=0').advice.some((a) => /raw=1/.test(a)));
  assert.equal(info('https://drive.google.com/file/d/abc/view').kind, 'page');
  assert.ok(info('http://x.test/a.mp4').advice.some((a) => /https/.test(a)));
  assert.ok(info('https://bucket.s3.amazonaws.com/a.mp4?X-Amz-Signature=abc&X-Amz-Expires=60').advice.some((a) => /signed/.test(a)));
});

test('diagnoseUrlFailure explains the likely cause', () => {
  assert.match(diagnoseUrlFailure(4, info('https://vimeo.com/123'), noHls).message, /Vimeo page/);
  assert.match(diagnoseUrlFailure(4, info('https://x.test/a.mpd'), noHls).message, /DASH/);
  assert.match(diagnoseUrlFailure(4, info('https://x.test/a.m3u8'), noHls).message, /hls\.js/);
  assert.match(diagnoseUrlFailure(2, info('https://x.test/a.mp4'), noHls).message, /could not be reached/);
  assert.match(diagnoseUrlFailure(null, info('https://x.test/a.mp4'), noHls).message, /30 seconds/);
  const generic = diagnoseUrlFailure(4, info('https://x.test/a.mp4'), noHls);
  assert.ok(generic.hints.some((h) => /hotlinking/.test(h)));
  assert.ok(diagnoseUrlFailure(4, info('https://x.test/a.avi'), noHls).hints.some((h) => /AVI/.test(h)));
});

test('computeUrlVerdict', () => {
  const meta = { duration: 10, width: 1280, height: 720, aspect: '16:9', hasVideo: true };
  const base = { info: info('https://x.test/a.mp4'), metadata: meta, seek: 'pass' as const };
  assert.equal(computeUrlVerdict({ ...base, cors: 'pass' }).verdict, 'open');
  const limited = computeUrlVerdict({ ...base, cors: 'fail' });
  assert.equal(limited.verdict, 'limited');
  assert.ok(limited.diagnosis.hints.some((h) => /Access-Control-Allow-Origin/.test(h)));
  assert.equal(computeUrlVerdict({ ...base, info: info('http://x.test/a.mp4'), cors: 'pass' }).verdict, 'limited');
  assert.equal(computeUrlVerdict({ ...base, metadata: { ...meta, width: 0, height: 0, hasVideo: false }, cors: 'pass' }).verdict, 'partial');
  assert.ok(computeUrlVerdict({ ...base, seek: 'fail', cors: 'pass' }).diagnosis.hints.some((h) => /range requests/.test(h)));
});

test('URL report', () => {
  const state = emptyUrlState();
  state.info = info('https://cdn.example.com/clip.mp4');
  state.verdict = 'open';
  state.checks.cors = { status: 'pass', detail: '' };
  const text = generateUrlReport(state, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0', now: new Date(0) });
  for (const line of ['Video URL Test Report', 'URL: https://cdn.example.com/clip.mp4', 'Open to all origins (CORS, no cookies): PASS', 'Result: Open access — playable on any site']) {
    assert.ok(text.includes(line), `missing ${line}\n${text}`);
  }
});

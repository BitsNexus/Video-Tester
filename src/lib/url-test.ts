/**
 * URL checker: "Is this video open to play on any site?"
 *
 * The page loads the link into <video> elements exactly like another website embedding it would:
 *  1. a plain <video src> (what any site can do)          → reachable + decodable + really plays
 *  2. a second probe with crossorigin="anonymous"         → the server sends CORS headers and needs
 *     no cookies, so JS players, canvas and fetch work too
 *  3. a seek to the middle                                → the server supports range requests
 * Nothing is fetched with JS (the CSP forbids it) and nothing is proxied — the browser talks to the
 * video's own server directly, sending no Referer (the page's referrer policy is no-referrer).
 */
import { getExtension } from './format.ts';
import { classifyPlayError, getMediaError, MESSAGES, type MediaErrorInfo } from './media-errors.ts';
import {
  cleanupVideo,
  isPageHidden,
  loadVideo,
  loadVideoData,
  readVideoMetadata,
  StageError,
  testVideoPlayback,
  waitFor,
  whenVisible,
  MEDIA_EVENTS,
  type Check,
  type CheckStatus,
  type LoggedEvent,
  type PlaybackResult,
  type PlaybackSample,
  type VideoMetadata,
} from './video-test.ts';

const URL_METADATA_TIMEOUT_MS = 30_000;
const URL_DATA_TIMEOUT_MS = 20_000;
const CORS_TIMEOUT_MS = 25_000;
const SEEK_TIMEOUT_MS = 12_000;

// ─── Link analysis (pure) ──────────────────────────────────────────────────────────────────

export type LinkKind = 'file' | 'hls' | 'dash' | 'page' | 'unknown';

export interface UrlInfo {
  href: string;
  protocol: 'https:' | 'http:';
  host: string;
  path: string;
  extension: string;
  kind: LinkKind;
  /** Human description, e.g. "MP4 video file", "HLS stream (.m3u8)". */
  format: string;
  /** Name of a known video *website* (YouTube, Vimeo…) when the link is a page, not a file. */
  site?: string;
  /** Extra, host-specific advice (Dropbox raw links, Drive pages…). */
  advice: string[];
}

const FILE_FORMATS: Record<string, string> = {
  mp4: 'MP4 video file',
  m4v: 'M4V video file',
  webm: 'WebM video file',
  mov: 'QuickTime (MOV) file',
  mkv: 'Matroska (MKV) file',
  ogv: 'Ogg video file',
  ogg: 'Ogg media file',
  avi: 'AVI file',
  wmv: 'WMV file',
  flv: 'Flash Video file',
  mpg: 'MPEG file',
  mpeg: 'MPEG file',
  '3gp': '3GP video file',
  ts: 'MPEG transport stream segment',
  m2ts: 'MPEG transport stream',
  mp3: 'MP3 audio file',
  m4a: 'M4A audio file',
};

const VIDEO_SITES: Array<[RegExp, string]> = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, 'YouTube'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/, 'Dailymotion'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(twitter\.com|x\.com)$/, 'X (Twitter)'],
  [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)loom\.com$/, 'Loom'],
  [/(^|\.)streamable\.com$/, 'Streamable'],
];

export type ParseResult = { ok: true; info: UrlInfo } | { ok: false; error: string };

export function analyzeUrl(raw: string): ParseResult {
  let text = raw.trim();
  if (!text) return { ok: false, error: 'Paste a link to a video first.' };
  // "example.com/clip.mp4" → assume https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That doesn’t look like a web address. It should start with https://' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const scheme = url.protocol.replace(':', '');
    return {
      ok: false,
      error:
        scheme === 'file'
          ? 'file:// links point to your own computer and can’t be opened by websites. Use the “Video file” tab to test a local file.'
          : `Only http:// and https:// links can be checked (this one uses “${scheme}:”).`,
    };
  }
  if (url.username || url.password) return { ok: false, error: 'Links with a username or password in them can’t be checked. Remove the “user:password@” part.' };

  const host = url.hostname.toLowerCase();
  const extension = getExtension(url.pathname.split('/').pop() ?? '');
  const advice: string[] = [];
  let kind: LinkKind = 'unknown';
  let format = 'Unknown (no file extension in the link)';
  let site: string | undefined;

  const known = VIDEO_SITES.find(([re]) => re.test(host));
  if (known) {
    kind = 'page';
    site = known[1];
    format = `${site} page`;
  } else if (extension === 'm3u8') {
    kind = 'hls';
    format = 'HLS stream (.m3u8)';
  } else if (extension === 'mpd') {
    kind = 'dash';
    format = 'MPEG-DASH manifest (.mpd)';
  } else if (FILE_FORMATS[extension]) {
    kind = 'file';
    format = FILE_FORMATS[extension];
  } else if (/\.(html?|php|aspx?)$/.test(url.pathname)) {
    kind = 'page';
    format = 'Web page';
  }

  if (/(^|\.)dropbox\.com$/.test(host)) {
    if (url.searchParams.get('dl') === '0' || !url.searchParams.has('raw')) {
      advice.push('Dropbox share links open a web page. For a direct video link, change “dl=0” to “raw=1” (or use dl.dropboxusercontent.com).');
    }
  } else if (/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/.test(host)) {
    kind = 'page';
    format = 'Google Drive page';
    advice.push('Google Drive links open a preview page, and Drive limits direct streaming of videos to other sites. Host the file somewhere that serves it directly (object storage, a CDN or your own server).');
  } else if (/(^|\.)(onedrive\.live\.com|1drv\.ms|sharepoint\.com)$/.test(host)) {
    advice.push('OneDrive/SharePoint share links open a viewer page, not the file itself, and usually require being signed in.');
  }
  if (url.protocol === 'http:') {
    advice.push('The link uses http://. Secure (https://) websites block or auto-upgrade insecure media, so it may not play on most sites. Serve the video over https://.');
  }
  if (/[?&](token|signature|sig|expires|x-amz-signature|x-goog-signature|policy|key-pair-id)=/i.test(url.search)) {
    advice.push('The link looks signed or time-limited (it carries a token/signature). It may stop working when it expires, or only work for you.');
  }

  return { ok: true, info: { href: url.href, protocol: url.protocol as UrlInfo['protocol'], host, path: url.pathname, extension, kind, format, site, advice } };
}

// ─── Diagnoses (pure) ──────────────────────────────────────────────────────────────────────

export interface UrlDiagnosis {
  message: string;
  hints: string[];
}

/** Why a link didn't load into a plain <video>. `code` = MediaError code, null = timed out. */
export function diagnoseUrlFailure(code: number | null, info: UrlInfo, canPlay: (type: string) => string): UrlDiagnosis {
  const hints = [...info.advice];
  if (info.kind === 'page' && info.site) {
    return {
      message: `This is a link to a ${info.site} page, not a direct video file. ${info.site} videos can only be shown through ${info.site}’s own embedded player (an <iframe>), so they can’t be played by a <video> tag on other sites.`,
      hints,
    };
  }
  if (info.kind === 'dash') {
    return {
      message: 'This is an MPEG-DASH manifest. Browsers can’t play DASH on their own — sites need a JavaScript player such as dash.js or Shaka Player, which also requires the server to send CORS headers.',
      hints,
    };
  }
  if (info.kind === 'hls' && !canPlay('application/vnd.apple.mpegurl')) {
    return {
      message: 'This is an HLS stream (.m3u8). This browser can’t play HLS natively, so sites need a JavaScript player such as hls.js — which also requires the server to send CORS headers.',
      hints: [...hints, 'Safari (and some newer browsers) play HLS natively; test the link there too.'],
    };
  }
  if (['avi', 'wmv', 'flv', 'mpg', 'mpeg'].includes(info.extension)) {
    hints.push(`${info.extension.toUpperCase()} files aren’t supported by web browsers, even when the link itself is public. Convert to MP4 (H.264 + AAC).`);
  }
  if (code === 2) {
    return {
      message: 'The video’s server could not be reached, or the download failed part-way. The server may be down, blocking this kind of request, or blocked by your network or an ad/privacy blocker.',
      hints,
    };
  }
  if (code === null) {
    return { message: 'The server didn’t send any playable video data within 30 seconds. It may be very slow, or it may be holding the request open without serving the video.', hints };
  }
  return {
    message: 'The server did not return a video this browser can play, so other sites can’t play it either. Common causes are listed below.',
    hints: [
      ...hints,
      'The link needs a login, or it has expired (signed or temporary links).',
      'The server blocks hotlinking — it only serves the video to its own website.',
      'The link opens a web page or download page rather than the video file itself.',
      'The file doesn’t exist any more (404) or access is denied (403).',
      'The format or codec isn’t supported by this browser (for example AVI, WMV or some MKV/HEVC files).',
    ],
  };
}

// ─── State ─────────────────────────────────────────────────────────────────────────────────

export type UrlCheckId = 'link' | 'load' | 'decode' | 'playback' | 'cors' | 'seek';
export type UrlVerdict = 'idle' | 'testing' | 'open' | 'limited' | 'blocked' | 'partial';

export interface UrlTestState {
  run: number;
  info: UrlInfo | null;
  checks: Record<UrlCheckId, Check>;
  verdict: UrlVerdict;
  diagnosis: UrlDiagnosis | null;
  needsUserStart: boolean;
  playbackRunning: boolean;
  playbackVerified: boolean;
  metadata: VideoMetadata | null;
  samples: PlaybackSample[];
  frames: number;
  cors: 'pending' | 'running' | 'pass' | 'fail';
  seek: 'pending' | 'running' | 'pass' | 'fail' | 'skipped';
  mediaError: MediaErrorInfo | null;
  playError: string | null;
  events: LoggedEvent[];
  startedAt: number;
}

const pendingCheck = (): Check => ({ status: 'pending', detail: 'Not tested' });

export function emptyUrlState(): UrlTestState {
  return {
    run: 0,
    info: null,
    checks: { link: pendingCheck(), load: pendingCheck(), decode: pendingCheck(), playback: pendingCheck(), cors: pendingCheck(), seek: pendingCheck() },
    verdict: 'idle',
    diagnosis: null,
    needsUserStart: false,
    playbackRunning: false,
    playbackVerified: false,
    metadata: null,
    samples: [],
    frames: 0,
    cors: 'pending',
    seek: 'pending',
    mediaError: null,
    playError: null,
    events: [],
    startedAt: 0,
  };
}

export const URL_VERDICT_TITLES: Record<UrlVerdict, string> = {
  idle: 'Not tested',
  testing: 'Testing…',
  open: 'Open access — playable on any site',
  limited: 'Playable on other sites, with limits',
  blocked: 'Not playable on other sites',
  partial: 'Link partially tested',
};

/** The final verdict once playback and the probes have finished. Pure, so it can be unit-tested. */
export function computeUrlVerdict(s: Pick<UrlTestState, 'info' | 'metadata' | 'cors' | 'seek'>): { verdict: UrlVerdict; diagnosis: UrlDiagnosis } {
  const info = s.info!;
  const hints = [...info.advice];
  if (s.seek === 'fail') hints.push('Seeking didn’t work: the server doesn’t seem to support range requests, so viewers can’t skip ahead and long videos load slowly. Enable “Accept-Ranges: bytes” on the server.');
  if (s.metadata && !s.metadata.hasVideo) {
    return { verdict: 'partial', diagnosis: { message: 'The link plays, but there is no video picture — it is audio-only, or its video codec isn’t supported by this browser.', hints } };
  }
  if (info.protocol === 'http:') {
    return { verdict: 'limited', diagnosis: { message: 'The video plays here, but it’s served over insecure http://, so most (https) websites can’t embed it reliably.', hints } };
  }
  if (s.cors === 'pass') {
    return {
      verdict: 'open',
      diagnosis: {
        message: 'Any website can play this video: it streams without a login or cookies, and the server allows cross-origin access (CORS), so it also works in JavaScript players, canvas and fetch.',
        hints,
      },
    };
  }
  return {
    verdict: 'limited',
    diagnosis: {
      message: 'Other sites can play it with a plain <video> tag, but the server doesn’t allow cross-origin (CORS) access without cookies.',
      hints: [
        ...hints,
        'JavaScript players that fetch the video themselves (hls.js, dash.js, Shaka, some video.js setups), canvas thumbnails and downloads via fetch() won’t work from other sites.',
        'It may also only be playing because you are signed in to that site (browsers send your cookies to plain <video> requests). Test in a private window to be sure.',
        'To open it fully, the server must send “Access-Control-Allow-Origin: *”.',
      ],
    },
  };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────────────────

export class UrlTester {
  state: UrlTestState = emptyUrlState();
  readonly video: HTMLVideoElement;
  private readonly canPlay: (type: string) => string;
  private runController: AbortController | null = null;
  private playbackController: AbortController | null = null;
  private listeners = new Set<(state: UrlTestState) => void>();
  private restoreMuted: boolean | null = null;
  private probe: HTMLVideoElement | null = null;

  constructor(video: HTMLVideoElement, canPlay?: (type: string) => string) {
    this.video = video;
    this.canPlay = canPlay ?? ((type) => video.canPlayType(type));
  }

  subscribe(fn: (state: UrlTestState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get active() {
    return this.state.info !== null;
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  private update(patch: Partial<UrlTestState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private check(id: UrlCheckId, status: CheckStatus, detail: string) {
    this.state = { ...this.state, checks: { ...this.state.checks, [id]: { status, detail } } };
    this.emit();
  }

  private log(type: string, detail = '') {
    const events = [...this.state.events, { at: performance.now() - this.state.startedAt, type, detail }];
    this.state = { ...this.state, events: events.length > 300 ? events.slice(-300) : events };
  }

  /** Start checking a link. Returns an error message if the link itself is invalid. */
  start(raw: string): string | null {
    const parsed = analyzeUrl(raw);
    if (!parsed.ok) return parsed.error;
    this.cleanup();
    void this.run(parsed.info);
    return null;
  }

  retest() {
    const info = this.state.info;
    if (!info) return;
    this.teardown();
    void this.run(info);
  }

  cleanup() {
    this.teardown();
    this.state = emptyUrlState();
    this.emit();
  }

  private teardown() {
    this.runController?.abort();
    this.playbackController?.abort();
    this.runController = null;
    this.playbackController = null;
    this.restoreMute();
    cleanupVideo(this.video);
    this.video.removeAttribute('crossorigin');
    if (this.probe) {
      cleanupVideo(this.probe);
      this.probe = null;
    }
  }

  private restoreMute() {
    if (this.restoreMuted === null) return;
    this.video.muted = this.restoreMuted;
    this.restoreMuted = null;
  }

  private async run(info: UrlInfo) {
    const controller = new AbortController();
    this.runController = controller;
    const { signal } = controller;

    this.state = { ...emptyUrlState(), run: this.state.run + 1, info, verdict: 'testing', startedAt: performance.now() };
    this.log('url', info.href);
    this.watchEvents(signal);

    this.check(
      'link',
      info.protocol === 'https:' ? (info.kind === 'page' ? 'warn' : 'pass') : 'warn',
      info.protocol === 'http:' ? 'Insecure http:// link — https sites may block it.' : info.kind === 'page' ? `${info.format} — not a direct video file.` : `Valid https link · ${info.format}.`,
    );

    // The CORS probe runs in parallel on its own element: crossorigin="anonymous" = no cookies + CORS required.
    const cors = this.corsProbe(info.href, signal);

    this.check('load', 'running', 'Loading the link in a plain <video> tag…');
    try {
      await loadVideo(this.video, info.href, signal, URL_METADATA_TIMEOUT_MS);
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof StageError ? error.code : null;
      this.update({ mediaError: getMediaError(this.video) });
      this.check('load', 'fail', code === null ? 'No response the browser could use within 30 seconds.' : 'The browser could not load a playable video from this link.');
      await cors.catch(() => undefined);
      if (signal.aborted) return;
      for (const id of ['decode', 'playback', 'seek'] as const) this.check(id, 'pending', 'Not tested');
      return this.update({ verdict: 'blocked', diagnosis: diagnoseUrlFailure(code, info, this.canPlay) });
    }
    const metadata = readVideoMetadata(this.video);
    this.update({ metadata });
    this.check('load', 'pass', `Loads from another site · ${metadata.hasVideo ? `${metadata.width} × ${metadata.height}` : 'no video picture'}.`);

    this.check('decode', 'running', 'Waiting for video data…');
    try {
      await loadVideoData(this.video, signal, URL_DATA_TIMEOUT_MS);
      this.check('decode', 'running', 'First frame loaded — confirming during playback…');
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof StageError && error.reason === 'error') {
        this.update({ mediaError: getMediaError(this.video) });
        this.check('decode', 'fail', 'The browser failed while decoding the video.');
        await cors.catch(() => undefined);
        return this.update({ verdict: 'blocked', diagnosis: { message: MESSAGES.unsupported, hints: info.advice } });
      }
      this.check('decode', 'running', 'No data buffered yet — the playback test will check.');
    }

    await this.seekTest(signal);
    if (signal.aborted) return;
    await this.playbackTest(true);
    await cors.catch(() => undefined);
    if (!signal.aborted) this.finish();
  }

  private async corsProbe(href: string, signal: AbortSignal) {
    const probe = document.createElement('video');
    this.probe = probe;
    probe.crossOrigin = 'anonymous';
    probe.muted = true;
    this.update({ cors: 'running' });
    this.check('cors', 'running', 'Loading again without cookies, as a cross-origin (CORS) request…');
    try {
      await loadVideo(probe, href, signal, CORS_TIMEOUT_MS);
      if (signal.aborted) return;
      this.update({ cors: 'pass' });
      this.check('cors', 'pass', 'Works without cookies, and the server sends CORS headers.');
      this.log('cors probe', 'loaded with crossorigin="anonymous"');
    } catch (error) {
      if (signal.aborted) return;
      this.update({ cors: 'fail' });
      const timedOut = error instanceof StageError && error.reason === 'timeout';
      this.check('cors', 'fail', timedOut ? 'The cross-origin request didn’t complete in time.' : 'Blocked: no CORS headers, or the server needs cookies/login.');
      this.log('cors probe', `failed (${error instanceof StageError ? error.reason : 'error'})`);
    } finally {
      cleanupVideo(probe);
      if (this.probe === probe) this.probe = null;
    }
  }

  /** Jump to the middle: only works if the server answers HTTP range requests. */
  private async seekTest(signal: AbortSignal) {
    const v = this.video;
    const duration = v.duration;
    if (!Number.isFinite(duration)) {
      this.update({ seek: 'skipped' });
      return this.check('seek', 'pass', 'Live or open-ended stream — seeking not applicable.');
    }
    if (duration < 4) {
      this.update({ seek: 'skipped' });
      return this.check('seek', 'pass', 'Clip is too short to need seeking.');
    }
    this.update({ seek: 'running' });
    this.check('seek', 'running', 'Jumping to the middle of the video…');
    const target = duration / 2;
    try {
      v.currentTime = target;
      await waitFor(v, 'seeked', () => !v.seeking && Math.abs(v.currentTime - target) < 1, SEEK_TIMEOUT_MS, signal);
      await waitFor(v, 'canplay', () => v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, SEEK_TIMEOUT_MS, signal);
      const ok = Math.abs(v.currentTime - target) < 2;
      this.update({ seek: ok ? 'pass' : 'fail' });
      this.check('seek', ok ? 'pass' : 'warn', ok ? 'Seeking works (the server supports range requests).' : 'The browser couldn’t jump ahead — the server may not support range requests.');
    } catch (error) {
      if (signal.aborted) return;
      this.update({ seek: 'fail' });
      this.check(
        'seek',
        'warn',
        error instanceof StageError && error.reason === 'error' ? 'The video failed while jumping ahead.' : 'Jumping ahead timed out — the server may not support range requests.',
      );
    }
    if (!signal.aborted) v.currentTime = 0;
  }

  /** The Start Playback Test button — call straight from the click handler (user activation). */
  startPlaybackTest() {
    if (!this.state.metadata || !this.runController) return;
    void this.playbackTest(false).then(() => {
      if (this.runController && !this.runController.signal.aborted && this.state.cors !== 'running') this.finish();
    });
  }

  private async playbackTest(automatic: boolean) {
    const runSignal = this.runController?.signal;
    if (!runSignal || runSignal.aborted) return;
    this.playbackController?.abort();
    const controller = new AbortController();
    this.playbackController = controller;
    const signal = controller.signal;
    runSignal.addEventListener('abort', () => controller.abort(), { signal });

    if (automatic && isPageHidden()) {
      this.check('playback', 'running', 'Waiting for this tab to be visible…');
      await whenVisible(signal);
      if (signal.aborted) return;
    }

    this.restoreMute();
    if (automatic) {
      this.restoreMuted = this.video.muted;
      this.video.muted = true;
      this.video.currentTime = 0;
    }
    const hasVideo = this.state.metadata?.hasVideo ?? false;
    this.update({ needsUserStart: false, playbackRunning: true, samples: [], frames: 0, playError: null, verdict: 'testing', diagnosis: null });
    this.check('playback', 'running', 'Starting playback…');

    let result: PlaybackResult;
    try {
      result = await testVideoPlayback(this.video, {
        signal,
        hasVideo,
        onSample: (sample, frames) => {
          const samples = [...this.state.samples, sample];
          this.update({ samples: samples.length > 120 ? samples.slice(-120) : samples, frames });
        },
      });
    } catch (error) {
      if (signal.aborted) return;
      this.restoreMute();
      const info = classifyPlayError(error);
      this.update({ playbackRunning: false, playError: `${info.name}: ${info.message}` });
      this.log('play() rejected', `${info.name}: ${info.message}`);
      if (info.kind === 'autoplay' || info.kind === 'aborted') {
        this.check('playback', 'warn', info.kind === 'autoplay' ? 'Automatic playback was blocked by the browser — not a problem with the link.' : 'Playback was interrupted.');
        if (this.state.checks.decode.status === 'running') this.check('decode', 'pending', 'Not verified yet — run the playback test.');
        return this.update({ needsUserStart: true, verdict: 'partial', diagnosis: { message: info.kind === 'autoplay' ? MESSAGES.autoplay : 'Playback was interrupted. Click ‘Start Playback Test’ to try again.', hints: [] } });
      }
      this.update({ mediaError: getMediaError(this.video) });
      this.check('playback', 'fail', 'play() was rejected by the browser.');
      if (this.state.checks.decode.status === 'running') this.check('decode', 'fail', 'The video could not be decoded.');
      return this.update({ verdict: 'blocked', diagnosis: { message: info.kind === 'unsupported' ? MESSAGES.unsupported : MESSAGES.playback, hints: this.state.info?.advice ?? [] } });
    }
    if (signal.aborted) return;
    this.update({ playbackRunning: false, frames: result.frames });
    if (automatic && result.outcome !== 'interrupted') {
      this.video.pause();
      this.video.currentTime = 0;
    }
    this.restoreMute();

    const advanced = `${result.advanced.toFixed(2)}s of playback${result.frames ? `, ${result.frames} frames decoded` : ''}`;
    if (result.outcome === 'verified' || result.outcome === 'no-frames') {
      this.check('playback', 'pass', `Playback started and advanced (${advanced}).`);
      this.check('decode', result.frames > 0 || !hasVideo ? 'pass' : 'warn', result.frames > 0 ? `${result.frames} video frames decoded.` : hasVideo ? 'No decoded frames were reported.' : 'Audio decoded (no video picture).');
      this.update({ playbackVerified: true });
    } else if (result.outcome === 'interrupted') {
      this.check('playback', 'warn', 'Playback was paused before it could be verified.');
      this.update({
        needsUserStart: true,
        verdict: 'partial',
        diagnosis: { message: 'Playback was paused before it could be verified. Click ‘Start Playback Test’ to try again.', hints: isPageHidden() ? ['The browser paused the video because this tab was in the background.'] : [] },
      });
    } else if (result.outcome === 'slow') {
      this.check('playback', 'warn', `Playback kept stalling (${advanced}) — the server may be slow.`);
      this.update({ playbackVerified: true });
    } else {
      this.update({ mediaError: getMediaError(this.video) });
      this.check('playback', 'fail', result.outcome === 'error' ? 'A media error occurred during playback.' : 'play() succeeded, but the video never advanced.');
      if (this.state.checks.decode.status !== 'pass') this.check('decode', 'fail', 'No frames were decoded.');
      this.update({ verdict: 'blocked', diagnosis: { message: 'The link loaded, but the video never played — the browser couldn’t decode it, or the server stopped sending data.', hints: this.state.info?.advice ?? [] } });
    }
  }

  /** Combine playback + probes into the verdict (only once playback is verified). */
  private finish() {
    if (!this.state.playbackVerified || this.state.verdict === 'blocked') return;
    const { verdict, diagnosis } = computeUrlVerdict(this.state);
    this.update({ verdict, diagnosis });
  }

  private watchEvents(signal: AbortSignal) {
    for (const type of MEDIA_EVENTS) {
      this.video.addEventListener(
        type,
        () => {
          if (type === 'timeupdate') return this.emit();
          const e = type === 'error' ? getMediaError(this.video) : null;
          this.log(type, e ? `${e.code} ${e.name}${e.browserMessage ? ` — ${e.browserMessage}` : ''}` : `t=${this.video.currentTime.toFixed(2)}s`);
          this.emit();
        },
        { signal },
      );
    }
  }
}

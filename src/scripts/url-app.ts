/**
 * UI for the URL checker: the link form in the hero and the results workspace.
 * The URL is only ever put into <video src> and shown via textContent.
 */
import { formatDuration, formatSeconds, getBrowserName, getOsName, NETWORK_STATES, READY_STATES } from '../lib/format';
import { generateUrlReport } from '../lib/report';
import { URL_VERDICT_TITLES, UrlTester, type UrlTestState, type UrlVerdict } from '../lib/url-test';
import { getPlaybackState } from '../lib/video-test';
import { $, $$, announce, CHECK_TEXT, copyText, copyWithFeedback, downloadText, fillList, fillRows, reduceMotion, renderScheduler, setText, swapClasses, TONE_LOOK, type Tone } from './dom';
import { onModeChange, setMode } from './modes';

/** A small CC0 clip from MDN's examples, served with CORS — a known-good "open" link. */
const EXAMPLE_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const form = $<HTMLFormElement>('[data-url-form]');
const input = $<HTMLInputElement>('[data-url-input]');
const error = $('[data-url-error]');
const root = $('[data-url-workspace]');
const stats = $('[data-stats]');
const video = $<HTMLVideoElement>('[data-u-video]', root);
const placeholder = $('[data-u-placeholder]', root);
const tech = $<HTMLDetailsElement>('[data-u-tech]', root);
const q = <T extends Element = HTMLElement>(sel: string) => $<T>(sel, root);

const tester = new UrlTester(video);
const ua = navigator.userAgent;

const VERDICT_TONE: Record<UrlVerdict, Tone> = { idle: 'pending', testing: 'running', open: 'pass', limited: 'warn', blocked: 'fail', partial: 'warn' };
const DEFAULT_MESSAGES: Record<UrlVerdict, string> = {
  idle: '',
  testing: 'Checking whether this link can be played from another website…',
  open: '',
  limited: '',
  blocked: '',
  partial: 'Playback couldn’t be verified automatically.',
};

// ─── Rendering ─────────────────────────────────────────────────────────────────────────────

let lastAnnounced = '';
const scheduleRender = renderScheduler(() => render(tester.state));
tester.subscribe(scheduleRender);

function render(state: UrlTestState) {
  const info = state.info;
  if (!info) return;
  const m = state.metadata;
  const tone = VERDICT_TONE[state.verdict];
  const [boxClass, iconClass, glyph] = TONE_LOOK[tone];
  const title = URL_VERDICT_TITLES[state.verdict];

  // Link bar
  setText(q('[data-u="host"]'), info.host);
  setText(q('[data-u="url"]'), info.href);
  const pill = q('[data-u="status"]');
  pill.dataset.status = tone;
  setText(pill, `${glyph} ${state.verdict === 'open' ? 'Open access' : state.verdict === 'limited' ? 'Playable, with limits' : state.verdict === 'blocked' ? 'Not playable' : state.verdict === 'partial' ? 'Partially tested' : 'Testing'}`);

  // Link information
  const corsText = { pending: '—', running: 'Testing…', pass: 'Allowed (no cookies needed)', fail: 'Not allowed / needs cookies' }[state.cors];
  const seekText = { pending: '—', running: 'Testing…', pass: 'Works', fail: 'Not supported or very slow', skipped: 'Not applicable' }[state.seek];
  const rows: Record<string, string> = {
    url: info.href,
    host: info.host,
    protocol: info.protocol === 'https:' ? 'HTTPS (secure)' : 'HTTP (insecure)',
    format: info.format,
    duration: m ? formatDuration(m.duration) : '—',
    resolution: m ? (m.hasVideo ? `${m.width} × ${m.height}` : 'No video picture') : '—',
    aspect: m?.aspect ?? '—',
    cors: corsText,
    seek: seekText,
  };
  for (const [key, value] of Object.entries(rows)) setText(q(`[data-u-info="${key}"]`), value);

  // Preview
  const failed = state.checks.load.status === 'fail';
  video.hidden = !m;
  placeholder.hidden = Boolean(m);
  setText(q('[data-u-placeholder-text]'), failed ? 'Preview unavailable — the browser could not load this link.' : 'Connecting to the video’s server…');

  // Playback button + help
  const playBtn = q<HTMLButtonElement>('[data-action="url-play-test"]');
  playBtn.disabled = !m || state.playbackRunning;
  setText(q('[data-u-play-label]'), state.playbackRunning ? 'Testing…' : state.playbackVerified ? 'Run Playback Test Again' : 'Start Playback Test');
  swapClasses(playBtn, 'attention', state.needsUserStart ? 'ring-4 ring-lime ring-offset-2' : 'ring-0');
  setText(
    q('[data-u-play-help]'),
    !m
      ? failed
        ? 'Playback can’t be tested because the link didn’t load.'
        : 'Waiting for the server to send the video’s metadata…'
      : state.needsUserStart
        ? 'Click ‘Start Playback Test’ to verify playback.'
        : state.playbackRunning
          ? 'Playing a short stretch to verify decoding…'
          : 'The automatic test plays a short, muted stretch. Click to test again with your current sound settings.',
  );

  const samples = state.samples.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
  const shown = samples.slice(-8).map((s) => formatSeconds(s.time));
  setText(
    q('[data-u-trace]'),
    shown.length ? `Current time: ${samples.length > 8 ? '… → ' : ''}${shown.join(' → ')}${state.frames ? ` · ${state.frames} frames decoded` : ''}` : 'Current time: —',
  );

  // Embed snippet once other sites can use it
  const embed = q('[data-u-embed]');
  embed.hidden = !(state.verdict === 'open' || state.verdict === 'limited');
  setText(q('[data-u-embed-code]'), embedCode(info.href));

  // Verdict
  const box = q('[data-u-verdict]');
  box.dataset.uVerdict = state.verdict;
  swapClasses(box, 'look', boxClass);
  const icon = q('[data-u-verdict-icon]');
  swapClasses(icon, 'look', iconClass);
  setText(icon, glyph);
  setText(q('[data-u-verdict-title]'), title);
  const message = state.diagnosis?.message ?? DEFAULT_MESSAGES[state.verdict];
  setText(q('[data-u-verdict-message]'), message);
  const hints = q('[data-u-hints]');
  hints.hidden = !state.diagnosis?.hints.length;
  fillList(hints, state.diagnosis?.hints ?? []);
  if (state.verdict !== 'testing' && lastAnnounced !== `${state.run}:${state.verdict}`) {
    lastAnnounced = `${state.run}:${state.verdict}`;
    announce(`${title}. ${message}`);
  }

  // Checks
  for (const li of $$('[data-u-check]', root)) {
    const check = state.checks[li.dataset.uCheck as keyof UrlTestState['checks']];
    const status = $('[data-u-check-status]', li);
    status.dataset.status = check.status;
    setText(status, CHECK_TEXT[check.status]);
    setText($('[data-u-check-detail]', li), check.detail);
  }

  if (tech.open) renderTech(state);
}

function renderTech(state: UrlTestState) {
  const pb = getPlaybackState(video);
  const err = state.mediaError;
  fillRows(q('[data-u-tech-props]'), [
    ['url', state.info?.href ?? ''],
    ['video.currentSrc', pb.currentSrc || '(none)'],
    ['video.readyState', `${pb.readyState} (${READY_STATES[pb.readyState] ?? '?'})`],
    ['video.networkState', `${pb.networkState} (${NETWORK_STATES[pb.networkState] ?? '?'})`],
    ['video.error', err ? `${err.code} ${err.name}${err.browserMessage ? `: ${err.browserMessage}` : ''}` : 'null'],
    ['play() rejection', state.playError ?? '(none)'],
    ['crossorigin="anonymous" probe', state.cors],
    ['seek test', state.seek],
    ['duration', String(pb.duration)],
    ['videoWidth × videoHeight', `${pb.videoWidth} × ${pb.videoHeight}`],
    ['video.currentTime', pb.currentTime.toFixed(3)],
    ['video.paused / ended', `${pb.paused} / ${pb.ended}`],
    ['video.buffered', pb.buffered],
    ['video.seekable', video.seekable.length ? `${video.seekable.start(0).toFixed(2)}–${video.seekable.end(video.seekable.length - 1).toFixed(2)}s` : 'none'],
    ['playback quality', pb.quality ? `${pb.quality.total} frames, ${pb.quality.dropped} dropped` : '(API unavailable)'],
    ['referrer sent', 'none (referrer policy: no-referrer)'],
  ]);
  const events = q('[data-u-tech-events]');
  const key = `${state.run}:${state.events.length}`;
  if (events.dataset.key !== key) {
    events.dataset.key = key;
    events.replaceChildren(
      ...state.events.map((e) => Object.assign(document.createElement('li'), { textContent: `+${Math.round(e.at).toString().padStart(5, ' ')}ms  ${e.type}${e.detail ? `  ${e.detail}` : ''}` })),
    );
  }
}

/** HTML snippet with the URL attribute-escaped. */
function embedCode(href: string) {
  const safe = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<video src="${safe}" controls playsinline preload="metadata"></video>`;
}

// ─── Flow ──────────────────────────────────────────────────────────────────────────────────

function showError(text: string) {
  error.textContent = text;
  error.hidden = !text;
  input.setAttribute('aria-invalid', text ? 'true' : 'false');
}

function check(raw: string) {
  setMode('url');
  const problem = tester.start(raw);
  if (problem) {
    showError(problem);
    input.focus();
    return;
  }
  showError('');
  input.value = tester.state.info?.href ?? raw;
  lastAnnounced = '';
  root.hidden = false;
  stats.hidden = true;
  announce(`Checking ${tester.state.info?.host ?? 'the link'}`);
  root.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

function clear({ quiet = false } = {}) {
  tester.cleanup();
  root.hidden = true;
  stats.hidden = false;
  showError('');
  if (quiet) return;
  announce('Link cleared.');
  input.focus();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  check(input.value);
});
input.addEventListener('input', () => error.hidden || showError(''));

onModeChange((mode) => {
  if (mode === 'file' && tester.active) clear({ quiet: true });
});

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-action]');
  switch (button?.dataset.action) {
    case 'url-example':
      input.value = EXAMPLE_URL;
      return check(EXAMPLE_URL);
    case 'url-retest':
      return tester.retest();
    case 'url-new':
      input.select();
      input.focus({ preventScroll: true });
      return input.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    case 'url-clear':
      input.value = '';
      return clear();
    case 'url-play-test':
      // Synchronous so the click's user activation reaches video.play().
      return tester.startPlaybackTest();
    case 'url-copy':
      return void copyWithFeedback(generateUrlReport(tester.state, { userAgent: ua }), q('[data-u-feedback]'));
    case 'url-download':
      return downloadText(generateUrlReport(tester.state, { userAgent: ua }), `${tester.state.info?.host ?? 'video'}-url-test-report.txt`);
    case 'url-embed-copy': {
      const text = embedCode(tester.state.info?.href ?? '');
      void copyText(text).then((ok) => {
        setText(button!, ok ? '✓ Copied' : 'Copy failed');
        setTimeout(() => (button!.innerHTML = button!.dataset.label ?? button!.innerHTML), 1500);
      });
      button!.dataset.label ??= button!.innerHTML;
      return;
    }
  }
});

tech.addEventListener('toggle', () => tech.open && renderTech(tester.state));

// Dropping a link (not a file) anywhere on the page checks it.
window.addEventListener('dragover', (event) => {
  const types = [...(event.dataTransfer?.types ?? [])];
  if (!types.includes('Files') && types.includes('text/uri-list')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  const types = [...(event.dataTransfer?.types ?? [])];
  if (types.includes('Files') || !types.includes('text/uri-list')) return;
  event.preventDefault();
  const link = event.dataTransfer!.getData('text/uri-list').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  if (!link) return;
  input.value = link;
  check(link);
});

window.addEventListener('pagehide', () => tester.cleanup());

setText(q('[data-u-browser]'), `${getBrowserName(ua)} on ${getOsName(ua)}`);
setText(q('[data-u-tech-ua]'), ua);

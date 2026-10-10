/**
 * UI state: wires the drop zone and buttons to the VideoTester and renders its state.
 * All text from the file (names, codec ids) goes in via textContent — never innerHTML.
 */
import { CAN_PLAY_PROBES } from '../data/formats';
import { liveObjectUrlCount } from '../lib/file-info';
import { canPlayLabel, formatBytes, formatDuration, formatSeconds, getBrowserName, getOsName, NETWORK_STATES, networkStateLabel, READY_STATES, readyStateLabel } from '../lib/format';
import { generateTestReport, VERDICT_TITLES } from '../lib/report';
import { getPlaybackState, VideoTester, type StepStatus, type TestState } from '../lib/video-test';
import { $, $$, announce, CHECK_TEXT, copyWithFeedback, downloadText, fillList, fillRows, reduceMotion, renderScheduler, setText, swapClasses, TONE_LOOK } from './dom';
import { onModeChange, setMode } from './modes';

const input = $<HTMLInputElement>('[data-file-input]');
const dropzone = $('[data-dropzone]');
const dropSection = $('[data-dropzone-section]');
const stats = $('[data-stats]');
const overlay = $('[data-drop-overlay]');
const dropMessage = $('#drop-message');
const workspace = $('[data-workspace]');
const video = $<HTMLVideoElement>('[data-video]');
const placeholder = $('[data-video-placeholder]');
const tech = $<HTMLDetailsElement>('[data-tech]');

const tester = new VideoTester(video);
const ua = navigator.userAgent;
const browserName = getBrowserName(ua);

// ─── Status vocabulary (icon + word, never colour alone) ───────────────────────────────────

const STEP_TEXT: Record<StepStatus, [glyph: string, word: string]> = {
  pending: ['○', 'Not started'],
  running: ['●', 'In progress'],
  success: ['✓', 'Done'],
  failed: ['✕', 'Failed'],
  warning: ['⚠', 'Needs attention'],
};

const STEP_MARKER: Record<StepStatus, string> = {
  pending: 'bg-white text-gray-400 ring-gray-300',
  running: 'bg-lime text-ink ring-lime animate-pulse motion-reduce:animate-none',
  success: 'bg-pass text-white ring-pass',
  failed: 'bg-fail text-white ring-fail',
  warning: 'bg-warn-bg text-warn ring-warn',
};

const VERDICT_STYLE = {
  idle: TONE_LOOK.pending,
  testing: TONE_LOOK.running,
  playable: TONE_LOOK.pass,
  failed: TONE_LOOK.fail,
  partial: TONE_LOOK.warn,
} as const;

const VERDICT_STATUS = { idle: 'pending', testing: 'running', playable: 'pass', failed: 'fail', partial: 'warn' } as const;

const DEFAULT_MESSAGES = {
  idle: '',
  testing: 'Checking what your browser can do with this file…',
  playable: 'The browser successfully loaded and played this video.',
  failed: 'The browser could not successfully decode or play this video.',
  partial: 'The file metadata could be read, but playback could not be verified automatically.',
} as const;

// ─── Rendering ─────────────────────────────────────────────────────────────────────────────

let lastAnnounced = '';
const scheduleRender = renderScheduler(() => render(tester.state));
tester.subscribe(scheduleRender);

function render(state: TestState) {
  const file = state.file;
  if (!file) return;
  const m = state.metadata;
  const h = state.header;

  // File bar
  setText($('[data-bar="name"]'), file.name);
  setText($('[data-bar="size"]'), file.sizeLabel);
  setText($('[data-bar="type"]'), file.mimeType);
  const barStatus = $('[data-bar="status"]');
  barStatus.dataset.status = VERDICT_STATUS[state.verdict];
  setText(barStatus, `${VERDICT_STYLE[state.verdict][2]} ${state.verdict === 'testing' ? 'Testing' : VERDICT_TITLES[state.verdict]}`);

  // Video information
  const tracks = (kind: 'video' | 'audio') => {
    if (!h) return '—';
    const list = h.tracks.filter((t) => t.kind === kind);
    if (list.length) return list.map((t) => `${t.name} (${t.id.trim()})`).join(', ');
    return ['mp4', 'matroska', 'avi', 'ogg'].includes(h.family) ? 'None found' : 'Not identified';
  };
  const info: Record<string, string> = {
    name: file.name,
    size: `${file.sizeLabel} (${file.size.toLocaleString()} bytes)`,
    type: file.reportedType || (file.mimeIsGuess ? `${file.mimeType} (not reported — guessed from extension)` : 'Not reported by your system'),
    ext: file.extension ? `.${file.extension}` : 'None',
    modified: file.lastModifiedLabel,
    container: h ? `${h.container}${h.brand && !h.container.toLowerCase().includes(h.brand.toLowerCase()) ? ` · brand “${h.brand}”` : ''}` : '—',
    vcodec: tracks('video'),
    acodec: tracks('audio'),
    duration: m ? formatDuration(m.duration) : '—',
    resolution: m ? (m.hasVideo ? `${m.width} × ${m.height}` : 'No video picture') : '—',
    aspect: m ? m.aspect : '—',
  };
  for (const [key, value] of Object.entries(info)) setText($(`[data-info="${key}"]`), value);

  // Preview: only once the browser accepted the source.
  const loadFailed = state.steps.metadata === 'failed' || state.checks.file.status === 'fail';
  video.hidden = !m;
  placeholder.hidden = Boolean(m);
  setText(
    $('[data-placeholder-text]'),
    loadFailed ? 'Preview unavailable — this browser could not open the file.' : 'Loading preview…',
  );

  // Playback test button
  const playBtn = $<HTMLButtonElement>('[data-action="play-test"]');
  playBtn.disabled = !m || state.playbackRunning;
  setText($('[data-play-label]'), state.playbackRunning ? 'Testing…' : state.verdict === 'playable' ? 'Run Playback Test Again' : 'Start Playback Test');
  swapClasses(playBtn, 'attention', state.needsUserStart ? 'ring-4 ring-lime ring-offset-2' : 'ring-0');
  setText(
    $('[data-play-help]'),
    !m
      ? loadFailed
        ? 'Playback can’t be tested because the browser could not read this file’s metadata.'
        : 'Waiting for the browser to read the video metadata…'
      : state.needsUserStart
        ? state.diagnosis?.kind === 'autoplay'
          ? 'Your browser blocked automatic playback. Click ‘Start Playback Test’ to continue.'
          : 'Click ‘Start Playback Test’ to verify playback.'
        : state.playbackRunning
          ? state.playedMuted
            ? 'Playing a short muted stretch to verify decoding…'
            : 'Playing to verify decoding…'
          : 'The automatic test plays a short, muted stretch. Click to test again with your current sound settings.',
  );

  // Trace
  const samples = state.samples.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
  const shown = samples.slice(-8).map((s) => formatSeconds(s.time));
  const trace = shown.length
    ? `${state.playbackRunning ? 'Playback started · ' : ''}Current time: ${samples.length > 8 ? '… → ' : ''}${shown.join(' → ')}${state.frames ? ` · ${state.frames} frames decoded` : ''}`
    : 'Current time: —';
  setText($('[data-trace]'), trace);

  // Timeline
  for (const li of $$('[data-step]')) {
    const id = li.dataset.step as keyof TestState['steps'];
    const status = state.steps[id];
    li.dataset.status = status;
    const [glyph, word] = STEP_TEXT[status];
    const marker = $('[data-step-marker]', li);
    swapClasses(marker, 'look', STEP_MARKER[status]);
    setText(marker, glyph);
    setText($('[data-step-state]', li), `${glyph} ${word}`);
    swapClasses(li, 'look', status === 'running' ? 'ring-lime bg-lime/10' : 'ring-gray-200 bg-gray-50');
    if (id === 'result') {
      setText(
        $('[data-step-label]', li),
        status === 'success' ? 'Playback successful' : status === 'failed' ? 'Playback failed' : status === 'warning' ? 'Partially verified' : 'Result',
      );
    }
  }

  // Verdict
  const box = $('[data-verdict]');
  const [boxClass, iconClass, glyph] = VERDICT_STYLE[state.verdict];
  box.dataset.verdict = state.verdict;
  swapClasses(box, 'look', boxClass);
  const icon = $('[data-verdict-icon]', box);
  swapClasses(icon, 'look', iconClass);
  setText(icon, glyph);
  const title = state.verdict === 'playable' ? '✓ Video is playable' : state.verdict === 'failed' ? '✕ Video could not be played' : state.verdict === 'partial' ? '⚠ Video partially tested' : 'Testing…';
  setText($('[data-verdict-title]', box), title.replace(/^[✓✕⚠] /, ''));
  setText($('[data-verdict-message]', box), state.diagnosis?.message ?? DEFAULT_MESSAGES[state.verdict]);
  const hintsEl = $('[data-verdict-hints]');
  const hints = state.diagnosis?.hints ?? [];
  hintsEl.hidden = hints.length === 0;
  fillList(hintsEl, hints);
  if (state.verdict !== 'testing' && lastAnnounced !== `${state.run}:${state.verdict}`) {
    lastAnnounced = `${state.run}:${state.verdict}`;
    announce(`${title.replace(/^[✓✕⚠] /, '')}. ${state.diagnosis?.message ?? DEFAULT_MESSAGES[state.verdict]}`);
  }

  // Checks
  for (const li of $$('[data-check]')) {
    const check = state.checks[li.dataset.check as keyof TestState['checks']];
    const pill = $('[data-check-status]', li);
    pill.dataset.status = check.status;
    setText(pill, CHECK_TEXT[check.status]);
    setText($('[data-check-detail]', li), check.detail);
  }

  // Playback information (live)
  const pb = getPlaybackState(video);
  const live: Record<string, string> = {
    ready: `${pb.readyState} · ${readyStateLabel(pb.readyState)}`,
    network: `${pb.networkState} · ${networkStateLabel(pb.networkState)}`,
    time: m ? formatDuration(pb.currentTime) + ` (${pb.currentTime.toFixed(2)}s)` : '—',
    duration: m ? formatDuration(pb.duration) : '—',
    paused: pb.paused ? 'Yes' : 'No',
    ended: pb.ended ? 'Yes' : 'No',
  };
  for (const [key, value] of Object.entries(live)) setText($(`[data-pb="${key}"]`), value);

  if (tech.open) renderTech(state);
}

function renderTech(state: TestState) {
  const file = state.file;
  if (!file) return;
  const pb = getPlaybackState(video);
  const m = state.metadata;
  const h = state.header;
  const err = state.mediaError;
  fillRows($('[data-tech-props]'), [
    ['file.name', file.name],
    ['extension', file.extension || '(none)'],
    ['file.type', file.reportedType || '(empty)'],
    ['file.size', `${file.size} bytes (${formatBytes(file.size)})`],
    ['file.lastModified', file.lastModified ? new Date(file.lastModified).toISOString() : '(unknown)'],
    ['header.container', h ? `${h.container}${h.brand ? ` [${h.brand}]` : ''}` : '(not read)'],
    ['header.tracks', h?.tracks.length ? h.tracks.map((t) => `${t.kind}: ${t.id.trim()}${t.codecs ? ` → ${t.codecs}` : ''}`).join('; ') : '(none identified)'],
    ['header.problems', h?.problems.length ? h.problems.join(' | ') : '(none)'],
    ['duration', m ? String(pb.duration) : String(video.duration)],
    ['dimensions', m ? `${pb.videoWidth} × ${pb.videoHeight}` : '—'],
    ['aspect ratio', m?.aspect ?? '—'],
    ['video.readyState', `${pb.readyState} (${READY_STATES[pb.readyState] ?? '?'})`],
    ['video.networkState', `${pb.networkState} (${NETWORK_STATES[pb.networkState] ?? '?'})`],
    ['video.error', err ? `${err.code} ${err.name}${err.browserMessage ? `: ${err.browserMessage}` : ''}` : 'null'],
    ['play() rejection', state.playError ?? '(none)'],
    ['video.currentSrc', pb.currentSrc || '(none)'],
    ['video.currentTime', pb.currentTime.toFixed(3)],
    ['video.paused', String(pb.paused)],
    ['video.ended', String(pb.ended)],
    ['video.muted / volume', `${pb.muted} / ${pb.volume}`],
    ['video.videoWidth', String(pb.videoWidth)],
    ['video.videoHeight', String(pb.videoHeight)],
    ['video.buffered', pb.buffered],
    ['playback quality', pb.quality ? `${pb.quality.total} frames, ${pb.quality.dropped} dropped` : '(API unavailable)'],
    ['frames during test', String(state.frames)],
    ['object URLs held', String(liveObjectUrlCount())],
  ]);

  const events = $('[data-tech-events]');
  if (events.dataset.count !== String(state.events.length) || events.dataset.run !== String(state.run)) {
    events.dataset.count = String(state.events.length);
    events.dataset.run = String(state.run);
    events.replaceChildren(
      ...state.events.map((e) => Object.assign(document.createElement('li'), { textContent: `+${Math.round(e.at).toString().padStart(5, ' ')}ms  ${e.type}${e.detail ? `  ${e.detail}` : ''}` })),
    );
  }
}

function renderStaticTech() {
  setText($('[data-tech-ua]'), ua);
  setText($('[data-browser]'), `${browserName} on ${getOsName(ua)}`);
  fillRows(
    $('[data-tech-canplay]'),
    CAN_PLAY_PROBES.map((type) => {
      const answer = video.canPlayType(type);
      return [type, `${canPlayLabel(answer)}${answer ? ` ("${answer}")` : ' ("")'}`];
    }),
  );
}

function renderFormatProbes() {
  for (const el of $$('[data-probe]')) {
    const answer = video.canPlayType(el.dataset.probe!);
    el.dataset.status = answer === 'probably' ? 'pass' : answer === 'maybe' ? 'warn' : 'fail';
    el.textContent = answer === 'probably' ? '✓ Probably' : answer === 'maybe' ? '⚠ Maybe' : '✕ No';
    el.title = `canPlayType('${el.dataset.probe}') → "${answer}"`;
  }
}

// ─── Flow ──────────────────────────────────────────────────────────────────────────────────

function showMessage(text: string) {
  dropMessage.textContent = text;
  dropMessage.hidden = !text;
}

function handleFiles(files: FileList | File[] | null | undefined) {
  const list = [...(files ?? [])];
  if (!list.length) return;
  const file = list[0];
  setMode('file');
  showMessage(list.length > 1 ? `Only one file can be tested at a time — testing “${file.name}”.` : '');

  dropSection.hidden = true;
  stats.hidden = true;
  workspace.hidden = false;
  lastAnnounced = '';
  announce(`Testing ${file.name}`);
  workspace.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  void tester.start(file);
}

function clearFile({ quiet = false } = {}) {
  tester.cleanup();
  workspace.hidden = true;
  dropSection.hidden = false;
  stats.hidden = false;
  showMessage('');
  input.value = '';
  if (quiet) return;
  announce('File cleared. Choose another video to test.');
  input.focus();
}

// Switching to the URL checker drops any file under test.
onModeChange((mode) => {
  if (mode === 'url' && tester.hasFile) clearFile({ quiet: true });
});

function browse() {
  setMode('file');
  input.value = ''; // allow re-selecting the same file
  input.click();
}

input.addEventListener('change', () => handleFiles(input.files));

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'browse':
      return browse();
    case 'clear':
      return clearFile();
    case 'retest':
      return void tester.retest();
    case 'play-test':
      // Synchronous call so the click's user activation reaches video.play().
      return tester.startPlaybackTest();
    case 'copy':
      return void copyReport();
    case 'download':
      return downloadReport();
  }
});

tech.addEventListener('toggle', () => tech.open && renderTech(tester.state));

// Drag & drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
const setDragging = (on: boolean) => {
  overlay.toggleAttribute('data-visible', on);
  dropzone.toggleAttribute('data-dragging', on);
};
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  setDragging(true);
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'copy';
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragging(false);
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  setDragging(false);
  handleFiles(event.dataTransfer?.files);
});

// ─── Report ────────────────────────────────────────────────────────────────────────────────

const report = () => generateTestReport(tester.state, { userAgent: ua, readyState: video.readyState, networkState: video.networkState });

const copyReport = () => copyWithFeedback(report(), $('[data-copy-feedback]'));

function downloadReport() {
  const base = (tester.state.file?.name ?? 'video').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
  downloadText(report(), `${base}-video-test-report.txt`);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('pagehide', () => tester.cleanup());
window.addEventListener('pageshow', (event) => {
  if (event.persisted && workspace.hidden === false) clearFile();
});

renderStaticTech();
renderFormatProbes();

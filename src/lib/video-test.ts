/**
 * The tester itself: loads a local file into a <video> element and watches what the browser
 * actually does with it. The verdict comes from real media behaviour (metadata, decoded data,
 * a play() that resolves and a clock that advances) — never from the file extension.
 */
import { createVideoObjectURL, getFileInformation, readFileHeader, revokeVideoObjectURL, type FileInformation } from './file-info.ts';
import { aspectRatio } from './format.ts';
import {
  classifyPlayError,
  describeMediaError,
  diagnoseLoadFailure,
  diagnosePlayFailure,
  getMediaError,
  headerHints,
  type Diagnosis,
  type MediaErrorInfo,
} from './media-errors.ts';
import type { HeaderInfo } from './sniff.ts';

// ─── Tunables ──────────────────────────────────────────────────────────────────────────────

/** Local files open in milliseconds; this only catches files the browser silently chokes on. */
const METADATA_TIMEOUT_MS = 20_000;
const DATA_TIMEOUT_MS = 10_000;
/** How much media time must pass before we call playback verified. */
const PLAYBACK_TARGET_S = 1.5;
/** Give up if the clock doesn't move for this long while we expect it to. */
const STALL_TIMEOUT_MS = 6_000;
/** Hard ceiling for the playback phase. */
const PLAYBACK_TIMEOUT_MS = 15_000;
const SAMPLE_EVERY_MS = 250;

export const MEDIA_EVENTS = [
  'loadstart',
  'durationchange',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'seeking',
  'seeked',
  'ended',
  'error',
  'abort',
  'emptied',
  'resize',
  'timeupdate',
] as const;

// ─── State ─────────────────────────────────────────────────────────────────────────────────

export type StepId = 'select' | 'load' | 'metadata' | 'data' | 'playback' | 'result';
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'warning';
export type CheckId = 'file' | 'metadata' | 'stream' | 'decode' | 'playback';
export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'warn';
export type VerdictKind = 'idle' | 'testing' | 'playable' | 'failed' | 'partial';

export interface Check {
  status: CheckStatus;
  detail: string;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  aspect: string;
  hasVideo: boolean;
}

export interface PlaybackSample {
  /** ms since the playback test started */
  at: number;
  time: number;
}

export interface LoggedEvent {
  at: number;
  type: string;
  detail: string;
}

export interface TestState {
  run: number;
  file: FileInformation | null;
  header: HeaderInfo | null;
  steps: Record<StepId, StepStatus>;
  checks: Record<CheckId, Check>;
  verdict: VerdictKind;
  diagnosis: Diagnosis | null;
  /** Autoplay was refused — the UI should push the Start Playback Test button. */
  needsUserStart: boolean;
  playbackRunning: boolean;
  metadata: VideoMetadata | null;
  samples: PlaybackSample[];
  /** Decoded/presented frames counted during the playback test. */
  frames: number;
  /** Did the playback test play with sound (user-started) or muted (automatic)? */
  playedMuted: boolean | null;
  mediaError: MediaErrorInfo | null;
  playError: string | null;
  events: LoggedEvent[];
  startedAt: number;
}

const initialChecks = (): Record<CheckId, Check> => ({
  file: { status: 'pending', detail: 'Not tested' },
  metadata: { status: 'pending', detail: 'Not tested' },
  stream: { status: 'pending', detail: 'Not tested' },
  decode: { status: 'pending', detail: 'Not tested' },
  playback: { status: 'pending', detail: 'Not tested' },
});

const initialSteps = (): Record<StepId, StepStatus> => ({
  select: 'pending',
  load: 'pending',
  metadata: 'pending',
  data: 'pending',
  playback: 'pending',
  result: 'pending',
});

export function emptyState(): TestState {
  return {
    run: 0,
    file: null,
    header: null,
    steps: initialSteps(),
    checks: initialChecks(),
    verdict: 'idle',
    diagnosis: null,
    needsUserStart: false,
    playbackRunning: false,
    metadata: null,
    samples: [],
    frames: 0,
    playedMuted: null,
    mediaError: null,
    playError: null,
    events: [],
    startedAt: 0,
  };
}

// ─── Reusable building blocks ──────────────────────────────────────────────────────────────

export class StageError extends Error {
  readonly reason: 'error' | 'timeout' | 'cancelled';
  readonly code: number | null;
  constructor(reason: StageError['reason'], code: number | null = null) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

/** Resolve when `ready()` is true or `event` fires; reject on `error`, timeout or abort. */
export function waitFor(video: HTMLVideoElement, event: string, ready: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new StageError('cancelled'));
    if (video.error) return reject(new StageError('error', video.error.code));
    if (ready()) return resolve();
    const done = new AbortController();
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      done.abort();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new StageError('timeout'))), timeoutMs);
    const opts = { signal: done.signal };
    video.addEventListener(event, () => finish(resolve), opts);
    video.addEventListener('error', () => finish(() => reject(new StageError('error', video.error?.code ?? null))), opts);
    signal.addEventListener('abort', () => finish(() => reject(new StageError('cancelled'))), opts);
  });
}

/** Point the element at the object URL and wait for `loadedmetadata`. */
export function loadVideo(video: HTMLVideoElement, url: string, signal: AbortSignal, timeoutMs = METADATA_TIMEOUT_MS): Promise<void> {
  video.preload = 'auto';
  video.src = url;
  video.load();
  return waitFor(video, 'loadedmetadata', () => video.readyState >= HTMLMediaElement.HAVE_METADATA, timeoutMs, signal);
}

/** Wait for the first frame of decoded data (`loadeddata`). */
export function loadVideoData(video: HTMLVideoElement, signal: AbortSignal, timeoutMs = DATA_TIMEOUT_MS): Promise<void> {
  return waitFor(video, 'loadeddata', () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, timeoutMs, signal);
}

export function readVideoMetadata(video: HTMLVideoElement): VideoMetadata {
  const width = video.videoWidth;
  const height = video.videoHeight;
  return { duration: video.duration, width, height, aspect: aspectRatio(width, height), hasVideo: width > 0 && height > 0 };
}

export interface PlaybackState {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  readyState: number;
  networkState: number;
  currentSrc: string;
  videoWidth: number;
  videoHeight: number;
  seeking: boolean;
  playbackRate: number;
  buffered: string;
  quality: { total: number; dropped: number } | null;
}

export function getPlaybackState(video: HTMLVideoElement): PlaybackState {
  const q = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
  const ranges: string[] = [];
  for (let i = 0; i < video.buffered.length; i++) ranges.push(`${video.buffered.start(i).toFixed(2)}–${video.buffered.end(i).toFixed(2)}s`);
  return {
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    ended: video.ended,
    muted: video.muted,
    volume: video.volume,
    readyState: video.readyState,
    networkState: video.networkState,
    currentSrc: video.currentSrc,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    seeking: video.seeking,
    playbackRate: video.playbackRate,
    buffered: ranges.join(', ') || 'none',
    quality: q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null,
  };
}

/** Frames the browser has decoded so far (0 when the API is missing). */
const decodedFrames = (video: HTMLVideoElement) =>
  typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality().totalVideoFrames : 0;

export interface PlaybackResult {
  outcome: 'verified' | 'no-frames' | 'stalled' | 'slow' | 'interrupted' | 'error';
  advanced: number;
  frames: number;
  errorCode: number | null;
}

/**
 * Call `video.play()` and watch the media clock. Playback counts as verified once the clock has
 * advanced by PLAYBACK_TARGET_S (or the whole clip, if shorter) *and*, for files with a picture,
 * the browser has decoded frames. A short window is enough — the full video doesn't need to play.
 *
 * `play()` is called synchronously so a click handler's user activation carries over to it.
 * If it rejects, the rejection propagates (NotAllowedError = autoplay was blocked).
 */
export function testVideoPlayback(
  video: HTMLVideoElement,
  opts: { signal: AbortSignal; hasVideo: boolean; onSample: (sample: PlaybackSample, frames: number) => void },
): Promise<PlaybackResult> {
  const playPromise = video.play();
  return playPromise.then(
    () =>
      new Promise<PlaybackResult>((resolve) => {
        const t0 = performance.now();
        const startTime = video.currentTime;
        const startFrames = decodedFrames(video);
        let presented = 0;
        let lastTime = startTime;
        let lastMove = t0;
        const duration = video.duration;
        const target = Number.isFinite(duration) && duration > 0 ? Math.min(PLAYBACK_TARGET_S, Math.max(0.05, (duration - startTime) * 0.8)) : PLAYBACK_TARGET_S;
        const listeners = new AbortController();

        // requestVideoFrameCallback counts frames actually handed to the compositor (Chromium, Safari).
        let rvfcHandle = 0;
        const hasRvfc = 'requestVideoFrameCallback' in video;
        const onFrame = () => {
          presented++;
          rvfcHandle = video.requestVideoFrameCallback(onFrame);
        };
        if (hasRvfc) rvfcHandle = video.requestVideoFrameCallback(onFrame);

        const frames = () => Math.max(presented, decodedFrames(video) - startFrames);
        const finish = (outcome: PlaybackResult['outcome'], errorCode: number | null = null) => {
          clearInterval(interval);
          listeners.abort();
          if (hasRvfc) video.cancelVideoFrameCallback(rvfcHandle);
          resolve({ outcome, advanced: video.currentTime - startTime, frames: frames(), errorCode });
        };

        const check = () => {
          const now = performance.now();
          const time = video.currentTime;
          opts.onSample({ at: now - t0, time }, frames());
          if (time > lastTime + 0.001) {
            lastTime = time;
            lastMove = now;
          }
          const advanced = time - startTime;
          const framesOk = !opts.hasVideo || frames() > 0;
          if (advanced >= target && framesOk) return finish('verified');
          if (now - lastMove > STALL_TIMEOUT_MS) return finish(advanced > 0.05 ? 'slow' : 'stalled');
          if (now - t0 > PLAYBACK_TIMEOUT_MS) return finish(advanced >= target ? 'no-frames' : advanced > 0.05 ? 'slow' : 'stalled');
        };

        const interval = setInterval(check, SAMPLE_EVERY_MS);
        const on = (type: string, fn: () => void) => video.addEventListener(type, fn, { signal: listeners.signal });
        on('ended', () => {
          // A clip shorter than the target window that played to the end is a pass.
          const advanced = video.currentTime - startTime;
          if (advanced > 0) finish(!opts.hasVideo || frames() > 0 ? 'verified' : 'no-frames');
          else finish('stalled');
        });
        on('error', () => finish('error', video.error?.code ?? null));
        on('pause', () => {
          if (!video.ended && !opts.signal.aborted) {
            const advanced = video.currentTime - startTime;
            finish(advanced >= target && (!opts.hasVideo || frames() > 0) ? 'verified' : 'interrupted');
          }
        });
        opts.signal.addEventListener('abort', () => finish('interrupted'), { signal: listeners.signal });
        opts.onSample({ at: 0, time: startTime }, 0);
      }),
  );
}

export const isPageHidden = () => typeof document !== 'undefined' && document.hidden;

export function whenVisible(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = new AbortController();
    const finish = () => {
      done.abort();
      resolve();
    };
    document.addEventListener('visibilitychange', () => !document.hidden && finish(), { signal: done.signal });
    signal.addEventListener('abort', finish, { signal: done.signal });
  });
}

/** Stop playback, detach the source and free the decoder. */
export function cleanupVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────────────────

export type Listener = (state: TestState) => void;

export class Video-Tester {
  state: TestState = emptyState();
  private file: File | null = null;
  private url: string | null = null;
  /** Aborts every listener/timer of the current run. */
  private runController: AbortController | null = null;
  /** Aborts only the current playback test (a new Start click replaces it). */
  private playbackController: AbortController | null = null;
  private listeners = new Set<Listener>();
  private ourPause = false;
  /** The user's mute setting while the automatic (muted) test borrows the element. */
  private restoreMuted: boolean | null = null;

  readonly video: HTMLVideoElement;
  private readonly canPlay: (type: string) => string;

  constructor(video: HTMLVideoElement, canPlay?: (type: string) => string) {
    this.video = video;
    this.canPlay = canPlay ?? ((type) => video.canPlayType(type));
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  private update(patch: Partial<TestState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private step(id: StepId, status: StepStatus) {
    this.state = { ...this.state, steps: { ...this.state.steps, [id]: status } };
    this.emit();
  }

  private check(id: CheckId, status: CheckStatus, detail: string) {
    this.state = { ...this.state, checks: { ...this.state.checks, [id]: { status, detail } } };
    this.emit();
  }

  private log(type: string, detail = '') {
    const events = [...this.state.events, { at: performance.now() - this.state.startedAt, type, detail }];
    this.state = { ...this.state, events: events.length > 300 ? events.slice(-300) : events };
  }

  /** Start testing a newly selected file (cleans up the previous one). */
  async start(file: File) {
    this.cleanup();
    this.file = file;
    this.url = createVideoObjectURL(file);
    await this.run();
  }

  /** Run every stage again on the same file. */
  async retest() {
    if (!this.file) return;
    this.teardownRun();
    this.restoreMute();
    cleanupVideo(this.video);
    await this.run();
  }

  private teardownRun() {
    this.runController?.abort();
    this.playbackController?.abort();
    this.runController = null;
    this.playbackController = null;
  }

  /** Remove the file: stop playback, drop listeners and revoke the object URL. */
  cleanup() {
    this.teardownRun();
    this.restoreMute();
    cleanupVideo(this.video);
    revokeVideoObjectURL(this.url);
    this.url = null;
    this.file = null;
    this.state = emptyState();
    this.emit();
  }

  get hasFile() {
    return this.file !== null;
  }

  private async run() {
    const file = this.file;
    const url = this.url;
    if (!file || !url) return;

    const controller = new AbortController();
    this.runController = controller;
    const { signal } = controller;

    this.state = {
      ...emptyState(),
      run: this.state.run + 1,
      file: getFileInformation(file),
      verdict: 'testing',
      startedAt: performance.now(),
    };
    this.step('select', 'success');
    this.log('select', `${file.name} (${file.size.toLocaleString()} bytes)`);
    this.watchEvents(signal);

    // 1. Read the header locally. If even that fails, the file itself can't be loaded.
    this.check('file', 'running', 'Reading the file…');
    try {
      const header = await readFileHeader(file, this.state.file!.extension);
      if (signal.aborted) return;
      this.update({ header });
      if (file.size > 0) this.check('file', 'pass', 'The file could be read from your device.');
      else this.check('file', 'fail', 'The file is empty (0 bytes).');
    } catch (error) {
      if (signal.aborted) return;
      this.check('file', 'fail', 'The file could not be read from your device.');
      this.step('load', 'failed');
      return this.fail({
        kind: 'unreadable',
        severity: 'fail',
        message: 'The file could not be read. It may have been moved, renamed or deleted, or your browser was denied access to it.',
        hints: [String((error as Error)?.message ?? error)],
      });
    }

    // 2–3. Hand it to the browser and wait for metadata.
    this.step('load', 'running');
    this.check('metadata', 'running', 'Waiting for the browser…');
    try {
      await loadVideo(this.video, url, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof StageError && error.reason === 'cancelled')) return;
      const code = error instanceof StageError ? error.code : null;
      if (this.state.steps.load === 'running') this.step('load', code === 2 || code === 1 ? 'failed' : 'success');
      this.step('metadata', 'failed');
      this.update({ mediaError: getMediaError(this.video) ?? (code ? describeMediaError(code) : null) });
      this.check('metadata', 'fail', code === null ? 'The browser did not report any metadata in time.' : 'The browser could not read the video metadata.');
      this.skipRemaining(['stream', 'decode', 'playback']);
      return this.fail(diagnoseLoadFailure({ code, header: this.state.header, canPlay: this.canPlay, metadataLoaded: false }));
    }
    if (this.state.steps.load !== 'success') this.step('load', 'success');
    this.step('metadata', 'success');

    const metadata = readVideoMetadata(this.video);
    this.update({ metadata });
    this.check('metadata', 'pass', 'Duration, dimensions and tracks were read by the browser.');
    if (metadata.hasVideo) this.check('stream', 'pass', `Video picture: ${metadata.width} × ${metadata.height}.`);
    else this.check('stream', 'warn', 'No video picture was detected. The file may be audio-only, or its video codec is not supported by this browser.');

    // 4. First decoded data.
    this.step('data', 'running');
    this.check('decode', 'running', 'Waiting for decoded data…');
    let dataLoaded = false;
    try {
      await loadVideoData(this.video, signal);
      dataLoaded = true;
      this.step('data', 'success');
      this.check('decode', 'running', 'First frame loaded — confirming during playback…');
    } catch (error) {
      if (signal.aborted || (error instanceof StageError && error.reason === 'cancelled')) return;
      if (error instanceof StageError && error.reason === 'error') {
        this.step('data', 'failed');
        this.update({ mediaError: getMediaError(this.video) });
        this.check('decode', 'fail', 'The browser failed while decoding the video data.');
        this.skipRemaining(['playback']);
        return this.fail(diagnoseLoadFailure({ code: error.code, header: this.state.header, canPlay: this.canPlay, metadataLoaded: true }));
      }
      // Some browsers (notably iOS Safari) don't buffer until play() — let the playback test decide.
      this.step('data', 'warning');
      this.check('decode', 'running', 'The browser has not buffered any frames yet — the playback test will check.');
    }

    // 5. Try to play automatically (muted, so autoplay policies normally allow it).
    this.log('info', dataLoaded ? 'Starting automatic (muted) playback test' : 'Starting playback test without buffered data');
    await this.playbackTest({ automatic: true });
  }

  /** The Start Playback Test button. Must be called straight from a click handler. */
  startPlaybackTest() {
    if (!this.file || !this.state.metadata) return;
    void this.playbackTest({ automatic: false });
  }

  private async playbackTest({ automatic }: { automatic: boolean }) {
    const runSignal = this.runController?.signal;
    if (!runSignal || runSignal.aborted) return;
    this.playbackController?.abort();
    const controller = new AbortController();
    this.playbackController = controller;
    const signal = controller.signal;
    runSignal.addEventListener('abort', () => controller.abort(), { signal });

    // Browsers pause or throttle media in background tabs, so the automatic test waits for the tab.
    if (automatic && isPageHidden()) {
      this.step('playback', 'running');
      this.check('playback', 'running', 'Waiting for this tab to be visible…');
      this.log('info', 'Tab is in the background — waiting before the playback test');
      await whenVisible(signal);
      if (signal.aborted) return;
    }

    const hasVideo = this.state.metadata?.hasVideo ?? false;
    this.restoreMute();
    if (automatic) {
      this.restoreMuted = this.video.muted;
      this.video.muted = true;
    }

    // A fresh test starts from the beginning unless the user is already mid-video.
    if (automatic || this.video.ended) this.video.currentTime = 0;

    this.update({ needsUserStart: false, playbackRunning: true, samples: [], frames: 0, playError: null, playedMuted: this.video.muted, verdict: 'testing', diagnosis: null });
    this.step('playback', 'running');
    this.step('result', 'pending');
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
      const mediaError = getMediaError(this.video);
      if (mediaError) {
        this.update({ mediaError });
        this.step('playback', 'failed');
        this.check('playback', 'fail', 'The browser raised a media error when playback began.');
        if (this.state.checks.decode.status === 'running') this.check('decode', 'fail', 'Decoding failed.');
        return this.fail(diagnoseLoadFailure({ code: mediaError.code, header: this.state.header, canPlay: this.canPlay, metadataLoaded: true }));
      }
      const diagnosis = diagnosePlayFailure(info, this.state.header, this.canPlay);
      if (diagnosis.severity === 'warn') {
        this.step('playback', 'warning');
        this.check('playback', 'warn', info.kind === 'autoplay' ? 'Automatic playback was blocked by the browser — not a problem with the file.' : 'Playback was interrupted.');
        if (this.state.checks.decode.status === 'running') this.check('decode', 'pending', 'Not verified yet — run the playback test.');
        this.update({ needsUserStart: true });
        return this.partial(diagnosis);
      }
      this.step('playback', 'failed');
      this.check('playback', 'fail', 'play() was rejected by the browser.');
      return this.fail(diagnosis);
    }

    if (signal.aborted) return;
    this.update({ playbackRunning: false, frames: result.frames });

    if (automatic && result.outcome !== 'interrupted') {
      // The automatic test only needs a short window: pause, rewind and restore the user's sound setting.
      this.ourPause = true;
      this.video.pause();
      this.ourPause = false;
      this.video.currentTime = 0;
    }
    this.restoreMute();

    const advancedText = `${result.advanced.toFixed(2)}s of playback`;
    const framesText = result.frames > 0 ? `, ${result.frames} frame${result.frames === 1 ? '' : 's'} decoded` : '';
    const hints = headerHints(this.state.header, this.canPlay);

    switch (result.outcome) {
      case 'verified': {
        this.step('playback', 'success');
        this.check('playback', 'pass', `Playback started and advanced (${advancedText}${framesText}).`);
        if (hasVideo) {
          this.check('decode', 'pass', result.frames > 0 ? `${result.frames} video frames decoded.` : 'Video data decoded and played.');
          this.step('result', 'success');
          this.update({ verdict: 'playable', diagnosis: null });
        } else {
          this.check('decode', 'warn', 'Media decoded, but there is no video picture.');
          this.partial({
            kind: 'no-video',
            severity: 'warn',
            message: 'The file plays, but no video picture was found. It may be audio-only, or its video stream uses a codec this browser cannot decode.',
            hints,
          });
        }
        break;
      }
      case 'no-frames':
        this.step('playback', 'warning');
        this.check('playback', 'pass', `The media clock advanced (${advancedText}).`);
        this.check('decode', 'warn', 'The browser did not report any decoded video frames.');
        this.partial({
          kind: 'frames-unconfirmed',
          severity: 'warn',
          message: 'Playback advanced, but the browser did not confirm any decoded video frames. You may hear sound without a picture. Keep this tab visible and test again.',
          hints,
        });
        break;
      case 'slow':
        this.step('playback', 'warning');
        this.check('playback', 'warn', `Playback started but kept stopping (${advancedText}).`);
        this.partial({
          kind: 'stalled',
          severity: 'warn',
          message: 'Playback started but kept stalling, so it could not be fully verified. Very high resolutions or bitrates can be too heavy for this device.',
          hints,
        });
        break;
      case 'stalled':
        this.step('playback', 'failed');
        this.check('playback', 'fail', 'play() succeeded, but the video never advanced.');
        if (this.state.checks.decode.status === 'running') this.check('decode', 'fail', 'No frames were decoded.');
        this.fail({
          kind: 'stalled',
          severity: 'fail',
          message: 'The video loaded, but playback never got going — the browser could not decode the frames.',
          hints,
        });
        break;
      case 'interrupted':
        this.step('playback', 'warning');
        this.check('playback', 'warn', 'Playback was paused or interrupted before it could be verified.');
        if (this.state.checks.decode.status === 'running') this.check('decode', 'pending', 'Not verified yet — run the playback test.');
        this.update({ needsUserStart: true });
        this.partial({
          kind: 'interrupted',
          severity: 'warn',
          message: 'Playback was paused before it could be verified. Click ‘Start Playback Test’ to try again.',
          hints: isPageHidden() ? ['The browser paused the video because this tab was in the background. Keep the tab visible while testing.'] : [],
        });
        break;
      case 'error': {
        this.update({ mediaError: getMediaError(this.video) });
        this.step('playback', 'failed');
        this.check('playback', 'fail', 'A media error occurred during playback.');
        if (this.state.checks.decode.status !== 'pass') this.check('decode', 'fail', 'Decoding failed during playback.');
        this.fail(diagnoseLoadFailure({ code: result.errorCode, header: this.state.header, canPlay: this.canPlay, metadataLoaded: true }));
        break;
      }
    }
  }

  private restoreMute() {
    if (this.restoreMuted === null) return;
    this.video.muted = this.restoreMuted;
    this.restoreMuted = null;
  }

  private skipRemaining(ids: CheckId[]) {
    for (const id of ids) this.check(id, 'pending', 'Not tested');
  }

  private fail(diagnosis: Diagnosis) {
    this.step('result', 'failed');
    this.update({ verdict: 'failed', diagnosis, playbackRunning: false });
  }

  private partial(diagnosis: Diagnosis) {
    this.step('result', 'warning');
    this.update({ verdict: 'partial', diagnosis, playbackRunning: false });
  }

  /** Log media events for the timeline/event log, bound to the run's AbortSignal for cleanup. */
  private watchEvents(signal: AbortSignal) {
    for (const type of MEDIA_EVENTS) {
      this.video.addEventListener(
        type,
        () => {
          if (type === 'timeupdate') return this.emit(); // refresh live info, don't log (too chatty)
          if (type === 'loadstart' && this.state.steps.load === 'running') {
            this.step('load', 'success');
            this.step('metadata', 'running');
          }
          if (type === 'pause' && this.ourPause) return this.emit();
          let detail = '';
          if (type === 'error') {
            const e = getMediaError(this.video);
            detail = e ? `${e.code} ${e.name}${e.browserMessage ? ` — ${e.browserMessage}` : ''}` : '';
          } else if (type === 'resize' || type === 'loadedmetadata') {
            detail = `${this.video.videoWidth}×${this.video.videoHeight}`;
          } else if (type === 'durationchange') {
            detail = `${this.video.duration}`;
          } else {
            detail = `t=${this.video.currentTime.toFixed(2)}s`;
          }
          this.log(type, detail);
          this.emit();
        },
        { signal },
      );
    }
  }
}

/**
 * Error handling: turn MediaError codes, play() rejections and header hints into honest,
 * human-readable explanations. We never say a file is "definitely broken" — only what the
 * browser could or couldn't do, plus the evidence behind it.
 */
import type { HeaderInfo, TrackHint } from './sniff.ts';

export interface MediaErrorInfo {
  code: number;
  /** Standard constant name, e.g. MEDIA_ERR_SRC_NOT_SUPPORTED. */
  name: string;
  /** Browser-specific detail (`MediaError.message`), may be empty. */
  browserMessage: string;
  /** Plain-English meaning of the code. */
  meaning: string;
}

const MEDIA_ERRORS: Record<number, [string, string]> = {
  1: ['MEDIA_ERR_ABORTED', 'Loading was stopped before it finished.'],
  2: ['MEDIA_ERR_NETWORK', 'The browser could not read the file data.'],
  3: ['MEDIA_ERR_DECODE', 'The browser hit an error while decoding the media.'],
  4: ['MEDIA_ERR_SRC_NOT_SUPPORTED', 'The browser could not open this media. Its format or codec is not supported, or the file is not valid media.'],
};

export function describeMediaError(code: number, browserMessage = ''): MediaErrorInfo {
  const [name, meaning] = MEDIA_ERRORS[code] ?? [`UNKNOWN_ERROR_${code}`, 'The browser reported an unknown media error.'];
  return { code, name, browserMessage, meaning };
}

export function getMediaError(video: HTMLMediaElement): MediaErrorInfo | null {
  const error = video.error;
  return error ? describeMediaError(error.code, error.message ?? '') : null;
}

export type PlayErrorKind = 'autoplay' | 'unsupported' | 'aborted' | 'other';

export interface PlayErrorInfo {
  kind: PlayErrorKind;
  name: string;
  message: string;
}

/** Classify a rejected `video.play()` promise. */
export function classifyPlayError(error: unknown): PlayErrorInfo {
  const name = error instanceof Error || (typeof error === 'object' && error && 'name' in error) ? String((error as Error).name) : 'Error';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const kind: PlayErrorKind =
    name === 'NotAllowedError' ? 'autoplay' : name === 'NotSupportedError' ? 'unsupported' : name === 'AbortError' ? 'aborted' : 'other';
  return { kind, name, message };
}

// ─── Diagnoses ─────────────────────────────────────────────────────────────────────────────

export type DiagnosisKind =
  | 'empty'
  | 'unreadable'
  | 'not-video'
  | 'corrupted'
  | 'unsupported'
  | 'decode'
  | 'aborted'
  | 'timeout'
  | 'playback'
  | 'autoplay'
  | 'interrupted'
  | 'stalled'
  | 'no-video'
  | 'frames-unconfirmed';

export interface Diagnosis {
  kind: DiagnosisKind;
  severity: 'fail' | 'warn';
  message: string;
  hints: string[];
}

export const MESSAGES = {
  unsupported: 'Your browser could not decode this video. The file may use a codec that this browser does not support.',
  corrupted: 'The video metadata could not be read. The file may be corrupted or incomplete.',
  playback: 'The video loaded, but playback could not be started.',
  autoplay: "Your browser blocked automatic playback. Click 'Start Playback Test' to continue.",
} as const;

export type CanPlay = (type: string) => string;

/** Families browsers essentially never play natively. */
const RARELY_SUPPORTED = new Set(['avi', 'asf', 'flv', 'mpeg-ps', 'realmedia']);

/** Container MIME to probe codec support with (QuickTime/MKV MIME answers are unreliable). */
function probeType(track: TrackHint): string | null {
  if (!track.codecs) return null;
  const c = track.codecs;
  if (c === 'theora') return `video/ogg; codecs="${c}"`;
  if (c === 'vp8' || c === 'vp9' || c === 'vorbis') return `video/webm; codecs="${c}"`;
  return `video/mp4; codecs="${c}"`;
}

/** Is a detected codec one this browser says it can't handle? `null` = can't tell. */
export function codecSupport(track: TrackHint, canPlay: CanPlay): 'yes' | 'no' | 'unknown' {
  const type = probeType(track);
  if (!type) return /unknown|other/i.test(track.name) ? 'unknown' : 'no';
  return canPlay(type) ? 'yes' : 'no';
}

/** Specific, actionable hints derived from the file header. */
export function headerHints(header: HeaderInfo | null, canPlay: CanPlay): string[] {
  if (!header) return [];
  const hints: string[] = [...header.problems];

  if (RARELY_SUPPORTED.has(header.family)) {
    hints.push(`${header.container} files are generally not supported by web browsers, even when they play in VLC or Windows Media Player. Converting to MP4 (H.264 video + AAC audio) makes them play almost everywhere.`);
  } else if (header.family === 'mpeg-ts') {
    hints.push('MPEG transport streams (.ts/.m2ts) usually only play in Safari. Other browsers need them remuxed to MP4.');
  } else if (header.family === 'matroska' && header.brand !== 'webm' && header.mime && !canPlay(header.mime)) {
    hints.push('MKV support differs between browsers. Chromium-based browsers often play MKV files containing H.264/VP9 + AAC/Opus; others may not.');
  }

  for (const track of header.tracks) {
    if (track.kind === 'other') continue;
    if (/Encrypted/.test(track.name)) {
      hints.push('This file is DRM protected (for example a purchased iTunes movie). It can only play in the store’s own player.');
      continue;
    }
    const support = codecSupport(track, canPlay);
    if (support !== 'no') continue;
    if (/HEVC|Dolby Vision \(HEVC\)/.test(track.name)) {
      hints.push('The video uses H.265/HEVC. Browser support depends on the browser, operating system and hardware decoder, so it plays on some computers and not others. Re-encoding to H.264 plays almost everywhere.');
    } else if (track.kind === 'video') {
      hints.push(`The video stream uses ${track.name}, which this browser reports it cannot play.`);
    } else {
      hints.push(`The audio stream uses ${track.name}, which this browser reports it cannot play. The picture may still work, but without sound — or not at all.`);
    }
  }
  hints.push(...header.notes);
  return [...new Set(hints)];
}

/** A codec the browser says it can't play, if any — strong evidence for "unsupported". */
function unsupportedVideoCodec(header: HeaderInfo | null, canPlay: CanPlay) {
  return header?.tracks.find((t) => t.kind === 'video' && !/Encrypted/.test(t.name) && codecSupport(t, canPlay) === 'no');
}

/**
 * Why the browser couldn't load the file before (or while) reading metadata.
 * `code` is the MediaError code, or null when we gave up waiting.
 */
export function diagnoseLoadFailure(input: {
  code: number | null;
  header: HeaderInfo | null;
  canPlay: CanPlay;
  metadataLoaded: boolean;
}): Diagnosis {
  const { code, header, canPlay, metadataLoaded } = input;
  const hints = headerHints(header, canPlay);
  const fail = (kind: DiagnosisKind, message: string, extra: string[] = []): Diagnosis => ({ kind, severity: 'fail', message, hints: [...extra, ...hints] });

  if (code === 2) return fail('unreadable', 'The browser could not read the file from your disk. It may have been moved, renamed or deleted, or it is on a drive that is no longer available.');
  if (code === 1) return fail('aborted', 'Loading was stopped before the browser finished reading the file. Try the test again.');

  if (header?.family === 'empty') return fail('empty', 'The file is empty (0 bytes), so there is nothing to play.');
  if (header?.family === 'not-video') {
    return fail('not-video', `This file does not appear to be a video — its content looks like a ${header.container}. The browser could not play it.`);
  }

  if (metadataLoaded) {
    // The container was understood, but decoding failed afterwards.
    if (code === 4 || unsupportedVideoCodec(header, canPlay)) return fail('unsupported', MESSAGES.unsupported);
    return fail(
      'decode',
      'The browser read the video metadata but failed while decoding the video. The file may be partially damaged, or use a codec feature this browser cannot handle.',
    );
  }

  if (header && header.problems.length) return fail('corrupted', MESSAGES.corrupted);
  if (header && RARELY_SUPPORTED.has(header.family)) return fail('unsupported', MESSAGES.unsupported);
  if (header?.family === 'mpeg-ts') return fail('unsupported', MESSAGES.unsupported);
  if (unsupportedVideoCodec(header, canPlay)) return fail('unsupported', MESSAGES.unsupported);

  if (code === null) {
    return fail('timeout', 'The browser did not finish reading the video metadata in time. The file may be corrupted, or use a format this browser cannot handle.');
  }

  if (header && header.family !== 'unknown' && header.tracks.length > 0) {
    // Known container + codecs the browser claims to support, yet it still failed: damage is likely, not certain.
    return fail('corrupted', MESSAGES.corrupted, [
      `This browser normally supports ${header.container} with ${header.tracks.filter((t) => t.kind !== 'other').map((t) => t.name).join(' + ')}, so a damaged or incomplete file is a likely cause — but that can't be confirmed from here.`,
    ]);
  }

  if (!header || header.family === 'unknown') {
    return fail('unsupported', 'Your browser could not open this file. Its format was not recognised — it may not be a video, it may be damaged, or it may use a format browsers do not support.');
  }
  return fail('unsupported', MESSAGES.unsupported);
}

export function diagnosePlayFailure(error: PlayErrorInfo, header: HeaderInfo | null, canPlay: CanPlay): Diagnosis {
  const hints = headerHints(header, canPlay);
  switch (error.kind) {
    case 'autoplay':
      return { kind: 'autoplay', severity: 'warn', message: MESSAGES.autoplay, hints: [] };
    case 'unsupported':
      return { kind: 'unsupported', severity: 'fail', message: MESSAGES.unsupported, hints };
    case 'aborted':
      return { kind: 'interrupted', severity: 'warn', message: 'Playback was interrupted before it could be verified. Click ‘Start Playback Test’ to try again.', hints: [] };
    default:
      return { kind: 'playback', severity: 'fail', message: MESSAGES.playback, hints: [`The browser said: ${error.name}${error.message ? ` — ${error.message}` : ''}`, ...hints] };
  }
}

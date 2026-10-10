/**
 * Plain-text diagnostic report for "Copy results" and "Download report".
 * Pure function of the test state, so it is easy to test.
 */
import { formatDuration, formatSeconds, getBrowserName, getOsName, readyStateLabel, networkStateLabel } from './format.ts';
import type { CheckStatus, TestState } from './video-test.ts';
import { URL_VERDICT_TITLES, type UrlTestState } from './url-test.ts';

const STATUS_WORD: Record<CheckStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARNING',
  running: 'TESTING',
  pending: 'NOT TESTED',
};

export const VERDICT_TITLES = {
  idle: 'Not tested',
  testing: 'Testing…',
  playable: 'Video is playable',
  failed: 'Video could not be played',
  partial: 'Video partially tested',
} as const;

export interface ReportEnvironment {
  userAgent: string;
  readyState?: number;
  networkState?: number;
  now?: Date;
}

export function generateTestReport(state: TestState, env: ReportEnvironment): string {
  const f = state.file;
  const m = state.metadata;
  const h = state.header;
  const lines: string[] = ['Video File Test Report', ''];

  if (f) {
    lines.push(`File: ${f.name}`);
    lines.push(`Size: ${f.sizeLabel} (${f.size.toLocaleString('en-US')} bytes)`);
    lines.push(`Type: ${f.mimeType}${f.mimeIsGuess ? ' (guessed from extension)' : ''}`);
  }
  if (h) {
    lines.push(`Container: ${h.container}${h.brand ? ` (${h.brand})` : ''}`);
    for (const t of h.tracks.filter((t) => t.kind !== 'other')) lines.push(`${t.kind === 'video' ? 'Video' : 'Audio'} codec: ${t.name} [${t.id.trim()}]`);
  }
  if (m) {
    lines.push(`Duration: ${formatDuration(m.duration)}`);
    lines.push(`Resolution: ${m.hasVideo ? `${m.width}x${m.height} (${m.aspect})` : 'no video picture'}`);
  }

  lines.push('');
  lines.push(`File read: ${STATUS_WORD[state.checks.file.status]}`);
  lines.push(`Metadata: ${STATUS_WORD[state.checks.metadata.status]}`);
  lines.push(`Video stream: ${STATUS_WORD[state.checks.stream.status]}`);
  lines.push(`Video data: ${STATUS_WORD[state.checks.decode.status]}`);
  lines.push(`Playback: ${STATUS_WORD[state.checks.playback.status]}`);

  if (state.samples.length > 1) {
    const trace = state.samples.filter((_, i, all) => i % 2 === 0 || i === all.length - 1).slice(0, 12);
    lines.push(`Playback trace: ${trace.map((s) => formatSeconds(s.time)).join(' → ')}`);
  }
  if (state.frames > 0) lines.push(`Frames decoded during test: ${state.frames}`);

  lines.push('');
  lines.push(`Result: ${VERDICT_TITLES[state.verdict]}`);
  if (state.diagnosis) {
    lines.push(`Reason: ${state.diagnosis.message}`);
    for (const hint of state.diagnosis.hints) lines.push(`  - ${hint}`);
  }
  if (state.mediaError) {
    const e = state.mediaError;
    lines.push(`Media error: ${e.code} ${e.name}${e.browserMessage ? ` — ${e.browserMessage}` : ''}`);
  }
  if (state.playError) lines.push(`play() error: ${state.playError}`);

  lines.push('');
  if (env.readyState !== undefined) lines.push(`Ready state: ${env.readyState} (${readyStateLabel(env.readyState)})`);
  if (env.networkState !== undefined) lines.push(`Network state: ${env.networkState} (${networkStateLabel(env.networkState)})`);
  lines.push(`Browser: ${getBrowserName(env.userAgent)} on ${getOsName(env.userAgent)}`);
  lines.push(`Tested: ${(env.now ?? new Date()).toISOString()}`);
  lines.push('');
  lines.push('Tested locally in the browser — the file was not uploaded.');
  return lines.join('\n');
}

/** Text report for the URL checker. */
export function generateUrlReport(state: UrlTestState, env: ReportEnvironment): string {
  const info = state.info;
  const m = state.metadata;
  const c = state.checks;
  const lines: string[] = ['Video URL Test Report', ''];
  if (info) {
    lines.push(`URL: ${info.href}`);
    lines.push(`Host: ${info.host}`);
    lines.push(`Format (from link): ${info.format}`);
  }
  if (m) {
    lines.push(`Duration: ${formatDuration(m.duration)}`);
    lines.push(`Resolution: ${m.hasVideo ? `${m.width}x${m.height} (${m.aspect})` : 'no video picture'}`);
  }
  lines.push('');
  lines.push(`Valid link: ${STATUS_WORD[c.link.status]}`);
  lines.push(`Loads on other sites (<video> tag): ${STATUS_WORD[c.load.status]}`);
  lines.push(`Decodes: ${STATUS_WORD[c.decode.status]}`);
  lines.push(`Playback: ${STATUS_WORD[c.playback.status]}`);
  lines.push(`Open to all origins (CORS, no cookies): ${STATUS_WORD[c.cors.status]}`);
  lines.push(`Seeking / range requests: ${STATUS_WORD[c.seek.status]}`);
  if (state.samples.length > 1) {
    const trace = state.samples.filter((_, i, all) => i % 2 === 0 || i === all.length - 1).slice(0, 12);
    lines.push(`Playback trace: ${trace.map((s) => formatSeconds(s.time)).join(' → ')}`);
  }
  lines.push('');
  lines.push(`Result: ${URL_VERDICT_TITLES[state.verdict]}`);
  if (state.diagnosis) {
    lines.push(`Reason: ${state.diagnosis.message}`);
    for (const hint of state.diagnosis.hints) lines.push(`  - ${hint}`);
  }
  if (state.mediaError) {
    const e = state.mediaError;
    lines.push(`Media error: ${e.code} ${e.name}${e.browserMessage ? ` — ${e.browserMessage}` : ''}`);
  }
  if (state.playError) lines.push(`play() error: ${state.playError}`);
  lines.push('');
  lines.push(`Browser: ${getBrowserName(env.userAgent)} on ${getOsName(env.userAgent)}`);
  lines.push(`Tested: ${(env.now ?? new Date()).toISOString()}`);
  lines.push('');
  lines.push('Tested by loading the link into <video> elements from a third-party page, without a Referer header.');
  return lines.join('\n');
}

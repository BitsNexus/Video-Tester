/**
 * Small DOM helpers shared by the file tester (app.ts) and the URL checker (url-app.ts).
 * Untrusted text (file names, URLs, codec ids) only ever goes in through textContent.
 */

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

export function setText(el: Element | null, text: string) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Replace a class "slot" (the classes we set last time) without touching the static ones. */
export function swapClasses(el: HTMLElement, slot: string, classes: string) {
  const previous = el.dataset[slot];
  if (previous === classes) return;
  if (previous) el.classList.remove(...previous.split(' '));
  el.classList.add(...classes.split(' '));
  el.dataset[slot] = classes;
}

export function fillRows(tbody: HTMLElement, rows: Array<[string, string]>) {
  const doc = document.createDocumentFragment();
  for (const [key, value] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = key;
    const td = document.createElement('td');
    td.textContent = value;
    tr.append(th, td);
    doc.append(tr);
  }
  tbody.replaceChildren(doc);
}

export function fillList(list: HTMLElement, items: string[]) {
  const key = items.join('\n');
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
}

const announcer = Object.assign(document.createElement('div'), { className: 'sr-only' });
announcer.setAttribute('aria-live', 'polite');
document.body.append(announcer);

/** Screen-reader announcement (polite). */
export function announce(text: string) {
  announcer.textContent = '';
  setTimeout(() => (announcer.textContent = text), 50);
}

/**
 * Batch renders per animation frame. rAF doesn't run in background tabs, so fall back to a
 * timer there, and re-render when the tab becomes visible (a queued rAF may never have fired).
 */
export function renderScheduler(render: () => void) {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      render();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  };
  document.addEventListener('visibilitychange', () => {
    pending = false;
    schedule();
  });
  return schedule;
}

/** Copy text; returns false if every method failed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/contexts without the async clipboard API.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Save text as a .txt download via a short-lived object URL. */
export function downloadText(text: string, filename: string) {
  const href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Show "✓ Copied" (or an error) in a live region for a moment. */
export async function copyWithFeedback(text: string, feedback: HTMLElement) {
  const ok = await copyText(text);
  feedback.textContent = ok ? '✓ Copied to clipboard' : 'Copy failed — use Download report instead.';
  setTimeout(() => (feedback.textContent = ''), 2500);
}

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Shared status vocabulary (icon + word, never colour alone) ────────────────────────────

export type Tone = 'pending' | 'running' | 'pass' | 'fail' | 'warn';

export const CHECK_TEXT: Record<Tone, string> = {
  pass: '✓ Passed',
  fail: '✕ Failed',
  warn: '⚠ Warning',
  running: '● Testing',
  pending: '○ Not tested',
};

/** [verdict box classes, icon classes, glyph] per tone. */
export const TONE_LOOK: Record<Tone, readonly [string, string, string]> = {
  pending: ['bg-gray-50 ring-gray-200', 'bg-gray-200 text-gray-600', '○'],
  running: ['bg-gray-50 ring-gray-200', 'bg-lime text-ink animate-pulse motion-reduce:animate-none', '●'],
  pass: ['bg-pass-bg ring-pass-line', 'bg-pass text-white', '✓'],
  fail: ['bg-fail-bg ring-fail-line', 'bg-fail text-white', '✕'],
  warn: ['bg-warn-bg ring-warn-line', 'bg-warn text-white', '⚠'],
};

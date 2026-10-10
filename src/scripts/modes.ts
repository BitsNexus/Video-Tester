/**
 * The "Video file" / "Video URL" tabs in the hero (ARIA tabs pattern with arrow-key support).
 * Switching mode fires a `vt:mode` event so each tester can clean up its own state.
 */
import { $$ } from './dom';

export type Mode = 'file' | 'url';

const tabs = $$<HTMLButtonElement>('[data-mode-tab]');
const panels = $$('[data-mode-panel]');
let current: Mode = 'file';

export const currentMode = () => current;

export function setMode(mode: Mode, { focusTab = false } = {}) {
  const changed = mode !== current;
  current = mode;
  for (const tab of tabs) {
    const selected = tab.dataset.modeTab === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  }
  for (const panel of panels) panel.hidden = panel.dataset.modePanel !== mode;
  if (changed) document.dispatchEvent(new CustomEvent<Mode>('vt:mode', { detail: mode }));
}

export function onModeChange(fn: (mode: Mode) => void) {
  document.addEventListener('vt:mode', (event) => fn((event as CustomEvent<Mode>).detail));
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.dataset.modeTab as Mode));
  tab.addEventListener('keydown', (event) => {
    const i = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? i + 1 : event.key === 'ArrowLeft' ? i - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    setMode(target.dataset.modeTab as Mode, { focusTab: true });
  });
}

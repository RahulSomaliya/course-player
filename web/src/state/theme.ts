// prefs.theme (per profile, in ProgressState) → data-theme on <html>. null follows the OS.
// Mirrored to localStorage "cp:theme" so web/index.html can apply it before first paint — keep that
// inline script's key in sync with THEME_MIRROR_KEY.
import type { Prefs } from '../../../shared/types';
import { browserStore, writeString } from '../lib/storage';

export const THEME_MIRROR_KEY = 'cp:theme';

export function applyTheme(theme: Prefs['theme']): void {
  const root = document.documentElement;
  if (theme === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  writeString(browserStore(), THEME_MIRROR_KEY, theme);
}

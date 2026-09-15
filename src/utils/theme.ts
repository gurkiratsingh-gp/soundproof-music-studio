export const THEME_STORAGE_KEY = 'soundproof:theme';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = typeof THEME_PREFERENCES[number];
export type Theme = 'light' | 'dark';

export function normalizeThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(preference: string | null, prefersDark: boolean): Theme {
  const normalized = normalizeThemePreference(preference);
  return normalized === 'system' ? prefersDark ? 'dark' : 'light' : normalized;
}

export function initialThemePreference(): ThemePreference {
  try { return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return 'system'; }
}

export function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Kept for callers that only need the currently rendered light/dark value. */
export function initialTheme(): Theme {
  return resolveTheme(initialThemePreference(), systemPrefersDark());
}

export function applyTheme(preference: ThemePreference, prefersDark = systemPrefersDark()): Theme {
  const theme = resolveTheme(preference, prefersDark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#081217' : '#f5f2ea');
  try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* The UI still changes for this session. */ }
  return theme;
}

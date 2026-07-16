import { themes } from 'terlio.js';

export const INTERACTIVE_THEME_PROFILES = [
  { id: 'dark', label: 'Dark', description: 'Neutral dark theme with balanced contrast.' },
  { id: 'mono', label: 'Mono', description: 'No-color fallback using terminal emphasis.' },
  { id: 'amber', label: 'Amber', description: 'Warm retro palette for operational work.' },
  { id: 'ocean', label: 'Ocean', description: 'Cool high-contrast palette suited to chat.' },
  { id: 'forest', label: 'Forest', description: 'Low-fatigue green palette for long sessions.' },
  { id: 'synth', label: 'Synth', description: 'Vibrant magenta and cyan accents.' },
  { id: 'slate', label: 'Slate', description: 'Quiet professional palette that keeps content dominant.' },
  { id: 'paper', label: 'Paper', description: 'Light-terminal-aware palette for pale backgrounds.' },
  { id: 'matrix', label: 'Matrix', description: 'Opinionated green-on-dark diagnostic theme.' },
].filter((profile) => themes[profile.id]);

export const INTERACTIVE_THEME_NAMES = INTERACTIVE_THEME_PROFILES.map((profile) => profile.id);
export const DEFAULT_INTERACTIVE_THEME_NAME = themes.slate
  ? 'slate'
  : themes.ocean
    ? 'ocean'
    : INTERACTIVE_THEME_NAMES[0] || Object.keys(themes)[0] || 'dark';

export function isInteractiveThemeName(value) {
  return typeof value === 'string' && Boolean(themes[value]);
}

export function normalizeInteractiveThemeName(value) {
  return isInteractiveThemeName(value) ? value : DEFAULT_INTERACTIVE_THEME_NAME;
}

export function resolveInteractiveTheme(value) {
  return themes[normalizeInteractiveThemeName(value)] || themes.dark || Object.values(themes)[0] || {};
}

export function interactiveThemeProfile(value) {
  const name = normalizeInteractiveThemeName(value);
  return INTERACTIVE_THEME_PROFILES.find((profile) => profile.id === name)
    || { id: name, label: name, description: 'Terlio theme preset.' };
}

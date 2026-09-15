import { Moon, Sun } from 'lucide-react';
import type { Theme } from '../utils/theme';

export default function ThemeToggle({ theme, onToggle, className = '' }: { theme: Theme; onToggle: () => void; className?: string }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return <button
    type="button"
    className={`theme-toggle ${className}`.trim()}
    onClick={onToggle}
    aria-label={`Switch to ${next} mode`}
    aria-pressed={theme === 'dark'}
    title={`Switch to ${next} mode`}
  >
    {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
  </button>;
}

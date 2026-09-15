import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import type { Theme, ThemePreference } from '../utils/theme';

const OPTIONS: { value: ThemePreference; label: string; description: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', description: 'Match this device', icon: Monitor },
  { value: 'light', label: 'Light', description: 'Bright and warm', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Easy on the eyes', icon: Moon },
];

export default function ThemeSettings({ preference, resolvedTheme, onChange }: {
  preference: ThemePreference;
  resolvedTheme: Theme;
  onChange: (preference: ThemePreference) => void;
}) {
  return <section className="panel theme-settings" aria-labelledby="appearance-heading">
    <div className="section-heading">
      <div><span className="eyebrow">APPEARANCE</span><h2 id="appearance-heading">Choose your studio theme</h2></div>
      <span className="square-icon"><Palette size={21} /></span>
    </div>
    <p className="muted">Pick a theme or let SoundProof follow your phone, tablet, or computer.</p>
    <div className="theme-preference-options" role="radiogroup" aria-label="Theme preference">
      {OPTIONS.map(option => {
        const Icon = option.icon;
        const selected = preference === option.value;
        return <button key={option.value} type="button" role="radio" aria-checked={selected} className={'theme-preference ' + (selected ? 'selected' : '')} onClick={() => onChange(option.value)}>
          <span className={'theme-preview ' + option.value} aria-hidden="true"><span /><span /><span /></span>
          <span className="theme-preference-copy"><span><Icon size={17} />{option.label}</span><small>{option.description}</small></span>
          <span className="theme-check" aria-hidden="true">{selected && <Check size={14} />}</span>
        </button>;
      })}
    </div>
    <p className="theme-current" role="status"><span aria-hidden="true" />{preference === 'system' ? `Following your device · ${resolvedTheme} theme active` : `${resolvedTheme === 'dark' ? 'Dark' : 'Light'} theme active`}</p>
  </section>;
}

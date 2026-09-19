import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Eye, EyeOff, LoaderCircle, ArrowRight, Check, Mail, ChevronDown, AudioLines, Mic2, Music2, ShieldCheck } from 'lucide-react';
import type { User } from '../types';

type ProviderState = { configured: boolean; message: string };
type ProviderResponse = { email: ProviderState; google: ProviderState; apple: ProviderState };

const OAUTH_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled. You can try again or continue with email.',
  expired: 'That sign-in request expired or could not be verified. Please start again.',
  unavailable: 'The identity provider could not complete sign-in. Please try again or continue with email.',
  configuration: 'That sign-in option is not configured correctly on this server. Continue with email or ask the site owner to check setup.',
};

export function Brand() {
  return <span className="brand"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path className="logo-shield" d="M24 4 40 10v11.4c0 10.4-6.4 18.3-16 22.6C14.4 39.7 8 31.8 8 21.4V10L24 4Z" /><path className="logo-wave" d="M15 24h3l2.3-7.2L24 32l3.1-14 2.8 10 2.1-4h2" /></svg></span><span className="brand-word">Sound<span>Proof</span><span className="brand-dot">.</span></span></span>;
}

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderResponse | null>(null);
  const [providerError, setProviderError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    const oauthError = url.searchParams.get('auth_error');
    if (oauthError) {
      setProviderError(OAUTH_ERRORS[oauthError] || OAUTH_ERRORS.unavailable);
      url.searchParams.delete('auth_error');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
    const controller = new AbortController();
    fetch('/api/auth/providers', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<ProviderResponse>;
      })
      .then(setProviders)
      .catch(error => { if (error?.name !== 'AbortError') setProviderError(current => current || 'Social sign-in status is unavailable. Continue with email.'); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const response = await fetch('/api/auth/' + (register ? 'register' : 'login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Sign-in failed. Please try again.');
      onLogin(data.user);
    } catch (error) { setError(error instanceof Error && error.name === 'Error' ? error.message : 'Could not reach the server. Please try again.'); }
    finally { setBusy(false); }
  }

  function startProvider(provider: 'google' | 'apple') {
    const status = providers?.[provider];
    if (!status?.configured) { setProviderError(status?.message || 'This sign-in option is still being checked.'); return; }
    window.location.assign(`/api/auth/${provider}/start`);
  }

  return <main className="login-page">
    <section className="login-story" aria-labelledby="landing-title">
      <header className="landing-nav"><Brand /><a href="#sign-in" className="landing-signin-link">Open the studio <ArrowUpRight size={16} /></a></header>
      <div className="story-copy"><span className="eyebrow light">YOUR IDEAS. YOUR SOUND.</span><h1 id="landing-title">A little thought.<br />A whole new <em>song.</em></h1><p>SoundProof helps you shape a song from your own idea, sing along to the beat, and make the music yours.</p><a className="landing-cta" href="#sign-in">Start creating <ArrowRight size={17} /></a></div>
      <div className="login-art-frame"><img src="/soundproof-studio.svg" alt="SoundProof waveform shield beside a vinyl record" /></div>
      <div className="landing-overview" id="how-it-works"><span className="eyebrow light">YOUR STUDIO, YOUR WAY</span><h2>From first idea to first take.</h2><div className="landing-feature-list">
        <div className="landing-feature"><span className="landing-feature-icon"><AudioLines size={19} /></span><div><h3>Build an instrumental</h3><p>Choose a mood, genre, tempo, and instruments. Write a prompt and hear a playable track shaped by your choices.</p></div></div>
        <div className="landing-feature"><span className="landing-feature-icon"><Music2 size={19} /></span><div><h3>Write and follow lyrics</h3><p>When AI is available, ask Kavi for lyrics in your language. Follow highlighted lines while the instrumental plays.</p></div></div>
        <div className="landing-feature"><span className="landing-feature-icon"><Mic2 size={19} /></span><div><h3>Sing it your way</h3><p>Record your voice with a computer or phone mic, or make a pitch-adjusted karaoke backing from a song you upload.</p></div></div>
      </div></div>
      <div className="story-footer"><span><Check size={15} /> Create in many Indian languages</span><span>Made for your creativity</span></div>
    </section>
    <section className="login-form-panel" id="sign-in" aria-labelledby="sign-in-title">
      <div className="login-switch">{emailOpen ? (register ? 'Already have an account?' : 'New to SoundProof?') : 'Secure access to your studio'} {emailOpen && <button className="text-button" onClick={() => { setRegister(!register); setError(''); }} disabled={busy}>{register ? 'Sign in' : 'Create an account'} <ArrowUpRight size={15} /></button>}</div>
      <div className="login-form-wrap"><span className="eyebrow">YOUR PERSONAL MUSIC SPACE</span><h2 id="sign-in-title">{emailOpen && register ? 'Find your sound.' : 'Welcome back.'}</h2><p className="muted">{emailOpen && register ? 'Create your account and give your next idea a melody.' : 'Choose a secure way to open your music studio.'}</p>
        {providerError && <p className="notice error login-auth-error" role="alert">{providerError}</p>}
        <div className="login-methods" aria-label="Sign-in options">
          <button type="button" className="login-provider" onClick={() => startProvider('google')} disabled={!providers?.google.configured || busy} aria-describedby={!providers?.google.configured ? 'google-status google-data-note' : 'google-data-note'}>
            <span className="provider-mark google-mark" aria-hidden="true">G</span><span>Continue with Google</span><ArrowRight size={17} />
          </button>
          {!providers?.google.configured && <p id="google-status" className="provider-status">{providers?.google.message || 'Checking Google sign-in configuration…'}</p>}
          <button type="button" className="login-provider apple-provider" onClick={() => startProvider('apple')} disabled={!providers?.apple.configured || busy} aria-describedby={!providers?.apple.configured ? 'apple-status' : undefined}>
            <span className="provider-mark apple-mark" aria-hidden="true">A</span><span>Continue with Apple</span><ArrowRight size={17} />
          </button>
          {!providers?.apple.configured && <p id="apple-status" className="provider-status">{providers?.apple.message || 'Checking Apple sign-in configuration…'}</p>}
          <div className="login-divider"><span>or</span></div>
          <button type="button" className="login-provider email-provider" onClick={() => { setEmailOpen(value => !value); setError(''); }} aria-expanded={emailOpen}>
            <span className="provider-mark" aria-hidden="true"><Mail size={16} /></span><span>Continue with email</span><ChevronDown size={17} className={emailOpen ? 'open' : ''} />
          </button>
        </div>
        <div className="google-data-note" id="google-data-note"><ShieldCheck size={17} aria-hidden="true" /><p>Google sign-in asks for your basic profile and email. SoundProof uses your account ID to recognize you, your name to label your studio, and your email for your account. It does not request access to your Drive or contacts. <a href="/privacy.html">How we use your data</a></p></div>
        {emailOpen && <form onSubmit={submit} className="login-form local-login-form">
          <label htmlFor="login-name">Email or studio name<input id="login-name" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="you@example.com or your studio name" maxLength={254} required disabled={busy} /></label>
          <label htmlFor="login-password">Password<div className="password-field"><input id="login-password" type={visible ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder={register ? 'Create a password (8+ characters)' : 'Enter your password'} minLength={8} maxLength={128} required disabled={busy} /><button type="button" className="icon-button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          {error && <p className="notice error" role="alert">{error}</p>}
          <button className="button primary full" disabled={busy}>{busy && <LoaderCircle size={18} className="spin" />}{busy ? 'One moment…' : register ? 'Create local account' : 'Sign in to your studio'}{!busy && <ArrowRight size={18} />}</button>
        </form>}
        <p className="login-note">Email and studio-name passwords belong to this SoundProof installation. Google and Apple accounts stay separate unless you explicitly add account linking in a future version. Your song library is saved in this browser.</p>
        <div className="login-features"><span><span className="mini-logo" aria-hidden="true">♪</span> Create music</span><span>✦ Write lyrics</span><span>♫ Make it yours</span></div>
      </div><footer className="login-bottom"><span>A space for the songwriter in everyone.</span><nav aria-label="Legal information"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></nav></footer>
    </section>
  </main>;
}

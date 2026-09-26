import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link2, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Smartphone, Unplug } from 'lucide-react';
import { StudioPhoneMic } from '../utils/phoneCompanion';
import './phoneCompanion.css';

export default function PhoneMicPanel({ phoneMic, compact = false }: { phoneMic: StudioPhoneMic; compact?: boolean }) {
  const state = useSyncExternalStore(phoneMic.subscribe, phoneMic.getSnapshot, phoneMic.getSnapshot);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const titleId = useId();

  useEffect(() => {
    let active = true; setQr('');
    if (state.inviteUrl) QRCode.toDataURL(state.inviteUrl, { width: 260, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#083f37', light: '#ffffff' } })
      .then(value => { if (active) setQr(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [state.inviteUrl]);

  async function copyLink() {
    if (!state.inviteUrl) return;
    try { await navigator.clipboard.writeText(state.inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }

  const active = state.phase !== 'idle' && state.phase !== 'failed';
  return <section className={(compact ? 'phone-mic-panel compact' : 'panel phone-mic-panel')} aria-labelledby={titleId}>
    <div className="phone-panel-heading">
      <span className="phone-panel-icon"><Smartphone size={21} /></span>
      <div><span className="eyebrow">PHONE COMPANION</span>{compact ? <h4 id={titleId}>Connect your phone microphone</h4> : <h2 id={titleId}>Use your phone as a studio mic.</h2>}</div>
      <span className={'badge phone-state ' + state.phase}>{state.phase === 'connected' ? 'Connected' : state.phase === 'waiting' ? 'Ready to scan' : state.phase === 'connecting' ? 'Connecting' : state.phase === 'reconnecting' ? 'Reconnecting' : state.phase === 'creating' ? 'Preparing' : state.phase === 'failed' ? 'Needs attention' : 'Disconnected'}</span>
    </div>
    <p className="muted">{compact ? 'Pair here, then choose Phone microphone and arm its Start / Stop controls.' : 'Scan once from an iPhone, iPad, Android phone, or tablet. Its microphone streams directly to this browser, and its buttons can start or stop an armed recording.'}</p>

    {state.phase === 'idle' && <div className="phone-empty">
      {!compact && <div className="phone-feature-row"><span><Link2 size={17} /><strong>Pair in the browser</strong><small>No app install</small></span><span><ShieldCheck size={17} /><strong>Encrypted audio</strong><small>WebRTC stream</small></span><span><QrCode size={17} /><strong>Quick connect</strong><small>Scan or use code</small></span></div>}
      <button className="button primary" onClick={() => void phoneMic.createSession()}><Smartphone size={17} />Create phone connection</button>
    </div>}

    {state.phase === 'creating' && <div className="phone-loading" role="status"><LoaderCircle className="spin" size={22} /><div><strong>Creating a private invitation…</strong><span>This should take only a moment.</span></div></div>}

    {state.error && <p className="notice error" role="alert">{state.error}</p>}

    {state.phase === 'failed' && <div className="phone-recovery">
      <button className="button primary" onClick={() => void phoneMic.createSession()}><RefreshCw size={16} />Create a new connection</button>
      <p className="small-text muted">The old invitation is closed. A new connection creates a fresh private link and code.</p>
    </div>}

    {state.phase === 'waiting' && state.inviteUrl && <div className="phone-pairing">
      <div className="phone-qr">
        {qr ? <img src={qr} alt="QR code containing the private SoundProof phone invitation" /> : <span><LoaderCircle className="spin" /></span>}
        <small>Open your camera and scan</small>
      </div>
      <div className="phone-pair-copy">
        <span className="eyebrow">OR OPEN SOUNDPROOF ON YOUR PHONE</span>
        <p>Choose <strong>Connect with a code</strong>, then enter:</p>
        <output aria-label="Phone pairing code">{state.pairingCode}</output>
        <div className="button-row">
          <button className="button secondary small" onClick={() => void copyLink()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy private link'}</button>
          <button className="button secondary small" onClick={() => void phoneMic.createSession()}><RefreshCw size={15} />New code</button>
        </div>
        <p className="small-text muted">Invitation expires {state.expiresAt ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(state.expiresAt)) : 'soon'}. It works only once and is never saved with your songs.</p>
      </div>
    </div>}

    {state.phase === 'connected' && <div className="phone-connected" role="status">
      <span><Check size={18} /></span><div><strong>{state.deviceName || 'Phone microphone'} is connected</strong><p>Choose Phone microphone in “Sing it yourself”, then use Check phone microphone and speak to verify sound arrives. Arm controls before using Start on the phone.</p></div>
    </div>}

    {state.phase === 'reconnecting' && <div className="phone-loading" role="status"><LoaderCircle className="spin" size={22} /><div><strong>Restoring the phone connection…</strong><span>Controls are paused for a few seconds while WebRTC recovers.</span></div></div>}

    {active && <button className="text-button danger-text" onClick={() => void phoneMic.disconnect()}><Unplug size={15} />Disconnect phone</button>}

    {!compact && <div className="phone-connection-note"><ShieldCheck size={16} /><p><strong>Secure connection required.</strong> Use the deployed HTTPS address on both devices. Wi-Fi, a phone hotspot, Bluetooth tethering, or USB tethering can carry the connection. A web page cannot use a phone as a raw Bluetooth or USB microphone without an operating-system driver.</p></div>}
  </section>;
}

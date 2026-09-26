import { useEffect, useRef, useState } from 'react';
import { AudioLines, CheckCircle2, Headphones, LoaderCircle, Mic2, Radio, ShieldCheck, Square, Unplug } from 'lucide-react';
import { Brand } from './Login';
import { assessPhoneConnection, PHONE_RECONNECT_GRACE_MS } from '../utils/phoneCompanion';
import './phoneCompanion.css';

type Phase = 'ready' | 'joining' | 'connecting' | 'reconnecting' | 'connected' | 'failed';
type Recorder = 'idle' | 'countdown' | 'recording' | 'saving';
type Signal = { sequence: number; type: 'answer' | 'ice' | 'control'; payload: unknown };

async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The phone could not connect to SoundProof.');
  return data;
}

export default function PhoneCompanionPage() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const invite = fragment.get('inviteToken') || '';
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [micPaused, setMicPaused] = useState(false);
  const [armed, setArmed] = useState(false);
  const [recorder, setRecorder] = useState<Recorder>('idle');
  const [noiseReduction, setNoiseReduction] = useState(true);
  const peer = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const abort = useRef<AbortController | null>(null);
  const meterContext = useRef<AudioContext | null>(null);
  const meterTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const after = useRef(0);
  const studioCandidates = useRef<RTCIceCandidateInit[]>([]);
  const session = useRef<{ sessionId: string; deviceToken: string } | null>(null);

  useEffect(() => () => { void disconnect(false); }, []);

  function deviceName() {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';
    if (/iphone/i.test(navigator.userAgent)) return 'iPhone';
    if (/ipad/i.test(navigator.userAgent) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/android/i.test(navigator.userAgent)) return /mobile/i.test(navigator.userAgent) ? 'Android phone' : 'Android tablet';
    return 'Mobile microphone';
  }

  async function postSignal(sessionId: string, token: string, type: string, payload: unknown, signal: AbortSignal) {
    const response = await fetch(`/api/phone/sessions/${encodeURIComponent(sessionId)}/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: 'phone', type, payload }), signal,
    });
    await responseJson(response);
  }

  async function connect() {
    if (phase === 'joining' || phase === 'connecting' || phase === 'connected') return;
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setPhase('failed'); setError('Phone microphone access needs the deployed HTTPS address in Safari, Chrome, or Edge.'); return;
    }
    const pairingCode = code.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!invite && pairingCode.length < 6) { setError('Enter the pairing code shown in SoundProof.'); return; }
    setPhase('joining');
    const controller = new AbortController(); abort.current = controller;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) { meterContext.current = new AudioContextClass(); void meterContext.current.resume(); }
      const joined = await responseJson(await fetch('/api/phone/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invite ? { inviteToken: invite } : { pairingCode }), signal: controller.signal,
      })) as { sessionId: string; deviceToken: string; iceServers?: RTCIceServer[] };
      session.current = { sessionId: joined.sessionId, deviceToken: joined.deviceToken };
      window.history.replaceState({}, '', '/phone');
      const microphone = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { channelCount: 1, sampleRate: 48000, sampleSize: 24, echoCancellation: false, autoGainControl: false, noiseSuppression: noiseReduction },
      });
      if (controller.signal.aborted) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream.current = microphone; startMeter(microphone);
      setPhase('connecting');
      const connection = new RTCPeerConnection({ iceServers: joined.iceServers || [] }); peer.current = connection;
      microphone.getTracks().forEach(track => connection.addTrack(track, microphone));
      const controls = connection.createDataChannel('soundproof-controls', { ordered: true }); channel.current = controls;
      controls.onopen = () => {
        markConnected(connection, controls);
        controls.send(JSON.stringify({ type: 'device', name: deviceName() }));
      };
      controls.onclose = () => {
        if (channel.current === controls && !controller.signal.aborted) failConnection('The studio control connection closed. Return to SoundProof on the computer and create a new connection.');
      };
      controls.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 512) return;
        try {
          const value = JSON.parse(event.data) as { type?: string; armed?: boolean; recorder?: Recorder; message?: string };
          if (value.type === 'studio-status') { setArmed(Boolean(value.armed)); if (value.recorder) setRecorder(value.recorder); }
          if (value.type === 'blocked') setError(value.message || 'Arm phone controls on the computer first.');
        } catch { /* Ignore malformed peer messages. */ }
      };
      connection.onconnectionstatechange = () => {
        if (peer.current !== connection || controller.signal.aborted) return;
        const audioLive = Boolean(stream.current?.getAudioTracks().some(track => track.readyState === 'live'));
        const health = assessPhoneConnection(connection.connectionState, audioLive, controls.readyState === 'open');
        if (health === 'connected') markConnected(connection, controls);
        else if (health === 'failed') failConnection('The direct connection was lost. Return to SoundProof on the computer and create a new connection.');
        else if (connection.connectionState === 'disconnected') beginReconnect(connection, controls, controller);
      };
      setMicPaused(microphone.getAudioTracks().some(track => track.muted || !track.enabled));
      microphone.getAudioTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (peer.current === connection && !controller.signal.aborted) failConnection('This phone stopped sharing its microphone. Create a new connection and allow microphone access again.');
        }, { once: true });
        track.addEventListener('mute', () => { if (peer.current === connection) setMicPaused(true); });
        track.addEventListener('unmute', () => { if (peer.current === connection) setMicPaused(false); });
      });
      connection.onicecandidate = event => { if (event.candidate && !controller.signal.aborted) void postSignal(joined.sessionId, joined.deviceToken, 'ice', { candidate: event.candidate.toJSON() }, controller.signal).catch(() => undefined); };
      await connection.setLocalDescription(await connection.createOffer({ offerToReceiveAudio: false }));
      const offerSdp = connection.localDescription?.sdp;
      if (!offerSdp) throw new Error('This browser could not create a phone microphone offer.');
      await postSignal(joined.sessionId, joined.deviceToken, 'offer', { sdp: offerSdp }, controller.signal);
      void poll(joined.sessionId, joined.deviceToken, controller);
    } catch (caught) {
      if (!controller.signal.aborted) failConnection(caught instanceof Error ? caught.message : 'The phone could not connect. Check both devices and try again.');
    }
  }

  async function poll(sessionId: string, token: string, controller: AbortController) {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/phone/sessions/${encodeURIComponent(sessionId)}/signals?role=phone&after=${after.current}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store',
        });
        const data = await responseJson(response) as { signals?: Signal[]; next?: number };
        for (const item of data.signals || []) {
          after.current = Math.max(after.current, item.sequence);
          if (item.type === 'answer' && peer.current && !peer.current.remoteDescription) {
            const sdp = (item.payload as { sdp?: string })?.sdp;
            if (sdp) {
              await peer.current.setRemoteDescription({ type: 'answer', sdp });
              for (const candidate of studioCandidates.current.splice(0)) await peer.current.addIceCandidate(candidate).catch(() => undefined);
            }
          } else if (item.type === 'ice' && peer.current) {
            const candidate = (item.payload as { candidate?: RTCIceCandidateInit | null })?.candidate;
            if (candidate && peer.current.remoteDescription) await peer.current.addIceCandidate(candidate).catch(() => undefined);
            else if (candidate) studioCandidates.current.push(candidate);
          } else if (item.type === 'control' && (item.payload as { action?: string })?.action === 'disconnect') { void disconnect(false, false); setError('The studio ended this phone connection.'); setPhase('failed'); return; }
        }
        if (Number.isSafeInteger(data.next)) after.current = Number(data.next);
      } catch (caught) {
        if (!controller.signal.aborted) failConnection(caught instanceof Error ? caught.message : 'The phone connection was interrupted.');
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 650));
    }
  }

  function startMeter(microphone: MediaStream) {
    const context = meterContext.current; if (!context) return;
    const source = context.createMediaStreamSource(microphone); const analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    meterTimer.current = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples); let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      setLevel(Math.min(1, peak));
    }, 90);
  }

  function send(type: 'record-start' | 'record-stop') {
    setError('');
    if (!armed && type === 'record-start') { setError('Arm phone controls in the song recorder on your computer first.'); return; }
    if (type === 'record-start' && !stream.current?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted)) {
      setError('The phone microphone is paused. Keep this page open and unlocked, close other apps using the microphone, and reconnect if needed.'); return;
    }
    if (channel.current?.readyState === 'open') channel.current.send(JSON.stringify({ type }));
  }

  function clearReconnectTimer() {
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
  }

  function markConnected(connection: RTCPeerConnection, controls: RTCDataChannel) {
    const audioLive = Boolean(stream.current?.getAudioTracks().some(track => track.readyState === 'live'));
    if (peer.current === connection && assessPhoneConnection(connection.connectionState, audioLive, controls.readyState === 'open') === 'connected') {
      clearReconnectTimer(); setPhase('connected'); setError('');
    }
  }

  function beginReconnect(connection: RTCPeerConnection, controls: RTCDataChannel, controller: AbortController) {
    if (peer.current !== connection || controller.signal.aborted) return;
    setArmed(false); setPhase('reconnecting'); setError('Connection interrupted. Trying to reconnect…');
    if (reconnectTimer.current !== null) return;
    reconnectTimer.current = window.setTimeout(() => {
      reconnectTimer.current = null;
      const audioLive = Boolean(stream.current?.getAudioTracks().some(track => track.readyState === 'live'));
      if (peer.current === connection && assessPhoneConnection(connection.connectionState, audioLive, controls.readyState === 'open') !== 'connected') {
        failConnection('The studio did not reconnect. Return to SoundProof on the computer and create a new connection.');
      }
    }, PHONE_RECONNECT_GRACE_MS);
  }

  function failConnection(message: string) {
    void disconnect(false);
    setArmed(false); setPhase('failed'); setError(message);
  }

  function stopMedia() {
    clearReconnectTimer();
    if (meterTimer.current !== null) window.clearInterval(meterTimer.current); meterTimer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    void meterContext.current?.close(); meterContext.current = null;
    const controls = channel.current; const connection = peer.current;
    channel.current = null; peer.current = null;
    controls?.close(); connection?.close();
    setLevel(0); setMicPaused(false); setArmed(false); setRecorder('idle'); after.current = 0; studioCandidates.current = [];
  }

  async function disconnect(showReady = true, notifyServer = true) {
    const joined = session.current; session.current = null;
    if (notifyServer && channel.current?.readyState === 'open') {
      try { channel.current.send(JSON.stringify({ type: 'disconnect' })); } catch { /* The server teardown below is authoritative. */ }
    }
    const retirement = notifyServer && joined ? fetch(`/api/phone/sessions/${encodeURIComponent(joined.sessionId)}/phone`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joined.deviceToken}` }, body: '{}', keepalive: true,
    }).catch(() => undefined) : undefined;
    abort.current?.abort(); abort.current = null; stopMedia(); if (showReady) { setPhase('ready'); setError(''); }
    await retirement;
  }

  const busy = recorder === 'recording' || recorder === 'countdown' || recorder === 'saving';
  return <main className="phone-page">
    <header><Brand /><span className="badge"><Radio size={13} />Phone companion</span></header>
    <section className="phone-card">
      <div className="phone-hero-icon"><Mic2 size={27} /></div>
      <span className="eyebrow">SOUNDPROOF REMOTE MIC</span>
      <h1>{phase === 'connected' ? 'Your phone is connected.' : 'Turn this phone into your microphone.'}</h1>
      <p className="muted">Capture your voice on this device while SoundProof plays and saves the take on your computer.</p>

      {phase === 'ready' && <div className="phone-join">
        {!invite && <label>Pairing code<input inputMode="text" autoCapitalize="characters" autoComplete="one-time-code" maxLength={12} value={code} onChange={event => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ENTER CODE" /></label>}
        <label className="phone-quality-toggle"><input type="checkbox" checked={noiseReduction} onChange={event => setNoiseReduction(event.target.checked)} /><span><strong>Reduce room noise</strong><small>Recommended for phone microphones</small></span></label>
        <button className="button primary full" onClick={() => void connect()}><Mic2 size={18} />Allow mic & connect</button>
      </div>}

      {(phase === 'joining' || phase === 'connecting' || phase === 'reconnecting') && <div className="phone-loading" role="status"><LoaderCircle className="spin" size={24} /><div><strong>{phase === 'joining' ? 'Checking your private invitation…' : phase === 'reconnecting' ? 'Restoring the studio connection…' : 'Making the direct audio connection…'}</strong><span>{phase === 'reconnecting' ? 'Recording controls are paused while WebRTC reconnects.' : 'Keep SoundProof open on the computer.'}</span></div></div>}

      {phase === 'connected' && <div className="phone-remote">
        <div className="phone-meter"><span><AudioLines size={17} />Microphone level</span><meter aria-label="Phone microphone input level" min={0} max={1} high={.88} value={level} /></div>
        <p className="small-text">Keep this page open and your screen unlocked. Before recording, use <strong>Check phone microphone</strong> on the computer and speak to confirm sound arrives there.</p>
        {micPaused && <p className="notice error" role="alert">Your phone paused its microphone. Keep this page in front and close any other app using the microphone. Reconnect if the meter does not recover.</p>}
        <div className={'phone-arm-status ' + (armed ? 'armed' : '')}><span>{armed ? <CheckCircle2 size={18} /> : <ShieldCheck size={18} />}</span><div><strong>{armed ? 'Computer is armed' : 'Waiting for the computer'}</strong><small>{armed ? 'You can control this take here.' : 'Open a song, choose Phone microphone, then arm phone controls.'}</small></div></div>
        {!busy ? <button className="phone-record-button" disabled={!armed || micPaused} onClick={() => send('record-start')}><span><Mic2 size={28} /></span>Start recording</button>
          : recorder === 'recording' ? <button className="phone-record-button stop" onClick={() => send('record-stop')}><span><Square size={26} fill="currentColor" /></span>Stop & save</button>
          : <button className="phone-record-button" disabled><span><LoaderCircle size={27} className="spin" /></span>{recorder === 'countdown' ? 'Get ready…' : 'Saving on computer…'}</button>}
        <button className="text-button danger-text" onClick={() => void disconnect()}><Unplug size={15} />Disconnect this phone</button>
      </div>}

      {error && <p className="notice error" role="alert">{error}</p>}
      {phase === 'failed' && <button className="button secondary full" onClick={() => void disconnect()}>Try another code</button>}
      <p className="recording-tip"><Headphones size={15} />Wear headphones connected to the computer so the instrumental does not leak into this microphone.</p>
    </section>
    <footer><ShieldCheck size={14} />WebRTC encrypts the audio; SoundProof’s signaling server never stores it.</footer>
  </main>;
}

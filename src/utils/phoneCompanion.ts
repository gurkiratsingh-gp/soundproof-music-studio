export type PhoneMicPhase = 'idle' | 'creating' | 'waiting' | 'connecting' | 'reconnecting' | 'connected' | 'failed';
export type PhoneRecorderStatus = 'idle' | 'countdown' | 'recording' | 'saving';
export type PhoneControlCommand = 'record-start' | 'record-stop';

export interface PhoneMicState {
  phase: PhoneMicPhase;
  sessionId?: string;
  pairingCode?: string;
  inviteUrl?: string;
  expiresAt?: string;
  deviceName?: string;
  stream?: MediaStream;
  armed: boolean;
  error?: string;
}

type IceServer = RTCIceServer;
type SignalType = 'offer' | 'answer' | 'ice' | 'control';
type Signal = { sequence: number; type: SignalType; payload: unknown };
type SessionResponse = {
  sessionId: string;
  pairingCode: string;
  inviteUrl: string;
  expiresAt: string;
  iceServers?: IceServer[];
};

const EMPTY_STATE: PhoneMicState = { phase: 'idle', armed: false };
export const PHONE_RECONNECT_GRACE_MS = 8_000;

export type PhoneConnectionAssessment = 'connected' | 'reconnecting' | 'failed';

/** Keep both UIs honest while WebRTC briefly changes networks or ICE routes. */
export function assessPhoneConnection(state: RTCPeerConnectionState, audioLive: boolean, dataOpen: boolean): PhoneConnectionAssessment {
  if (state === 'failed' || state === 'closed') return 'failed';
  if (state === 'connected' && audioLive && dataOpen) return 'connected';
  return 'reconnecting';
}

function readableApiError(error: unknown, fallback: string) {
  if (error instanceof DOMException && error.name === 'AbortError') return 'The phone connection request timed out. Check the network and try again.';
  return error instanceof Error && error.message ? error.message : fallback;
}

async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The phone connection could not be completed.');
  return data;
}

/**
 * Owns the desktop side of one WebRTC phone-microphone session. The server
 * relays only short-lived setup messages; microphone audio uses encrypted
 * WebRTC transport directly between devices or through configured TURN.
 */
export class StudioPhoneMic {
  private state: PhoneMicState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private commands = new Set<(command: PhoneControlCommand) => void>();
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private abort?: AbortController;
  private pollAfter = 0;
  private phoneCandidates: RTCIceCandidateInit[] = [];
  private reconnectTimer?: number;
  private lifecycleGeneration = 0;

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeCommand = (listener: (command: PhoneControlCommand) => void) => { this.commands.add(listener); return () => { this.commands.delete(listener); }; };

  private patch(next: Partial<PhoneMicState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach(listener => listener());
  }

  async createSession() {
    const generation = ++this.lifecycleGeneration;
    // Reset synchronously so a double tap cannot leave two invitations polling.
    // The previous server session may finish deleting while the new UI prepares.
    const cleanup = this.resetSession();
    if (!window.isSecureContext) {
      await cleanup;
      if (generation !== this.lifecycleGeneration) return;
      this.patch({ phase: 'failed', armed: false, error: 'Phone microphone pairing needs HTTPS, or localhost while developing.' });
      return;
    }
    this.patch({ phase: 'creating', armed: false, error: undefined });
    await cleanup;
    if (generation !== this.lifecycleGeneration) return;
    const abort = new AbortController(); this.abort = abort;
    try {
      const response = await fetch('/api/phone/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: abort.signal,
      });
      const data = await jsonResponse(response) as SessionResponse;
      if (abort.signal.aborted || generation !== this.lifecycleGeneration) {
        void this.deleteSession(data.sessionId);
        return;
      }
      const inviteUrl = new URL(data.inviteUrl, window.location.origin).href;
      this.patch({
        phase: 'waiting', sessionId: data.sessionId, pairingCode: data.pairingCode,
        inviteUrl, expiresAt: data.expiresAt, error: undefined, stream: undefined, deviceName: undefined,
      });
      this.startPolling(data.sessionId, data.iceServers || [], abort);
    } catch (error) {
      if (!abort.signal.aborted && generation === this.lifecycleGeneration) this.patch({ phase: 'failed', armed: false, error: readableApiError(error, 'Could not create a phone pairing.') });
    }
  }

  private startPolling(sessionId: string, iceServers: IceServer[], abort: AbortController) {
    const poll = async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await fetch(`/api/phone/sessions/${encodeURIComponent(sessionId)}/signals?role=studio&after=${this.pollAfter}`, {
            signal: abort.signal, cache: 'no-store',
          });
          const data = await jsonResponse(response) as { signals?: Signal[]; next?: number };
          for (const signal of data.signals || []) await this.acceptSignal(signal, sessionId, iceServers, abort);
          if (Number.isSafeInteger(data.next)) this.pollAfter = Number(data.next);
        } catch (error) {
          if (!abort.signal.aborted) {
            this.patch({ phase: 'failed', armed: false, error: readableApiError(error, 'The phone connection was interrupted.') });
            this.closePeer();
          }
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 650));
      }
    };
    void poll();
  }

  private async acceptSignal(signal: Signal, sessionId: string, iceServers: IceServer[], abort: AbortController) {
    if (!Number.isSafeInteger(signal.sequence) || signal.sequence < 1) return;
    this.pollAfter = Math.max(this.pollAfter, signal.sequence);
    if (signal.type === 'control' && (signal.payload as { action?: string })?.action === 'disconnect') {
      this.failConnection('The phone ended this connection. Create a new connection when you are ready.'); return;
    }
    if (signal.type === 'ice') {
      const candidate = (signal.payload as { candidate?: RTCIceCandidateInit | null })?.candidate;
      if (candidate === null) return;
      if (!candidate || typeof candidate.candidate !== 'string') return;
      if (this.peer?.remoteDescription) await this.peer.addIceCandidate(candidate).catch(() => undefined);
      else this.phoneCandidates.push(candidate);
      return;
    }
    if (signal.type !== 'offer' || !signal.payload || typeof signal.payload !== 'object') return;
    const queuedCandidates = this.phoneCandidates.slice();
    this.closePeer();
    this.patch({ phase: 'connecting', armed: false, error: undefined });
    const peer = new RTCPeerConnection({ iceServers }); this.peer = peer;
    peer.onicecandidate = event => { if (event.candidate && !abort.signal.aborted) void this.postSignal(sessionId, 'ice', { candidate: event.candidate.toJSON() }, abort.signal).catch(() => undefined); };
    peer.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.patch({ stream }); this.updateConnected();
      event.track.addEventListener('ended', () => {
        if (this.peer === peer) this.failConnection('The phone microphone stopped sharing audio. Create a new connection and try again.');
      }, { once: true });
    };
    peer.ondatachannel = event => { this.attachChannel(event.channel); };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      const health = assessPhoneConnection(peer.connectionState, this.hasLiveAudio(), this.channel?.readyState === 'open');
      if (health === 'connected') this.updateConnected();
      else if (health === 'failed') this.failConnection('The direct audio connection was lost. Create a new connection and try again.');
      else if (peer.connectionState === 'disconnected' || this.state.phase === 'connected' || this.state.phase === 'reconnecting') this.beginReconnect(peer);
    };
    const offerSdp = (signal.payload as { sdp?: string }).sdp;
    if (!offerSdp) throw new Error('The phone sent an incomplete WebRTC offer.');
    await peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    for (const candidate of queuedCandidates) await peer.addIceCandidate(candidate).catch(() => undefined);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    const answerSdp = peer.localDescription?.sdp || answer.sdp;
    if (!answerSdp) throw new Error('The studio could not create a WebRTC answer.');
    await this.postSignal(sessionId, 'answer', { sdp: answerSdp }, abort.signal);
  }

  private attachChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => { this.updateConnected(); this.sendStatus('idle'); };
    channel.onclose = () => {
      if (this.channel === channel) {
        this.channel = undefined;
        this.failConnection('The phone control connection closed. Create a new connection and try again.');
      }
    };
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 512) return;
      try {
        const value = JSON.parse(event.data) as { type?: string; name?: string };
        if (value.type === 'device') {
          const name = typeof value.name === 'string' ? value.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48) : '';
          if (name) this.patch({ deviceName: name });
        } else if (value.type === 'record-start' || value.type === 'record-stop') {
          if (value.type === 'record-start' && !this.state.armed) { this.send({ type: 'blocked', message: 'Arm phone controls in SoundProof first.' }); return; }
          this.commands.forEach(listener => listener(value.type as PhoneControlCommand));
        } else if (value.type === 'disconnect') {
          this.failConnection('The phone ended this connection. Create a new connection when you are ready.');
        }
      } catch { /* Ignore malformed peer messages. */ }
    };
  }

  private updateConnected() {
    if (this.peer && assessPhoneConnection(this.peer.connectionState, this.hasLiveAudio(), this.channel?.readyState === 'open') === 'connected') {
      this.clearReconnectTimer();
      this.patch({ phase: 'connected', error: undefined });
    }
  }

  private hasLiveAudio() {
    return Boolean(this.state.stream?.getAudioTracks().some(track => track.readyState === 'live'));
  }

  private beginReconnect(peer: RTCPeerConnection) {
    if (this.peer !== peer) return;
    this.patch({ phase: 'reconnecting', armed: false, error: 'Connection interrupted. Trying to reconnect…' });
    if (this.reconnectTimer !== undefined) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.peer === peer && assessPhoneConnection(peer.connectionState, this.hasLiveAudio(), this.channel?.readyState === 'open') !== 'connected') {
        this.failConnection('The phone did not reconnect. Create a new connection and try again.');
      }
    }, PHONE_RECONNECT_GRACE_MS);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private failConnection(message: string) {
    const sessionId = this.state.sessionId;
    this.abort?.abort(); this.abort = undefined;
    this.closePeer(); this.pollAfter = 0;
    this.patch({ phase: 'failed', armed: false, stream: undefined, deviceName: undefined, error: message });
    if (sessionId) void this.deleteSession(sessionId);
  }

  private send(value: object) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(value));
  }

  setArmed(armed: boolean) {
    const enabled = armed && this.state.phase === 'connected';
    this.patch({ armed: enabled });
    this.send({ type: 'studio-status', armed: enabled, recorder: 'idle' });
  }

  sendStatus(recorder: PhoneRecorderStatus) {
    this.send({ type: 'studio-status', armed: this.state.armed, recorder });
  }

  getMicrophoneStream = async () => {
    const tracks = this.state.stream?.getAudioTracks().filter(track => track.readyState === 'live') || [];
    if (!tracks.length) throw new Error('The phone microphone disconnected. Reconnect it in Settings and try again.');
    // VocalCapture owns and stops the returned tracks, so clone the WebRTC track
    // and leave the companion connection alive for the next take.
    return new MediaStream(tracks.map(track => track.clone()));
  };

  private async postSignal(sessionId: string, type: SignalType, payload: unknown, signal: AbortSignal) {
    const response = await fetch(`/api/phone/sessions/${encodeURIComponent(sessionId)}/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'studio', type, payload }), signal,
    });
    await jsonResponse(response);
  }

  private closePeer() {
    this.clearReconnectTimer();
    const channel = this.channel; const peer = this.peer;
    this.channel = undefined; this.peer = undefined;
    channel?.close(); peer?.close();
    this.phoneCandidates = [];
  }

  private async deleteSession(sessionId: string) {
    await fetch(`/api/phone/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
    }).catch(() => undefined);
  }

  private async resetSession() {
    const sessionId = this.state.sessionId;
    this.abort?.abort(); this.abort = undefined;
    this.send({ type: 'disconnect' });
    this.closePeer(); this.pollAfter = 0;
    this.state = EMPTY_STATE; this.listeners.forEach(listener => listener());
    if (sessionId) await this.deleteSession(sessionId);
  }

  async disconnect() {
    this.lifecycleGeneration++;
    await this.resetSession();
  }
}

import { AudioEngine } from '../src/utils/audioEngine';
import { StudioPhoneMic, type PhoneControlCommand } from '../src/utils/phoneCompanion';
import { VocalCapture, type RecordedAudio } from '../src/utils/vocalRecording';
import { initialSongs } from '../src/utils/initialSongs';

const results: { name: string; details?: unknown }[] = [];
const baseline = new URLSearchParams(location.search).has('baseline');
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, message: string, ms = 8000) {
  const deadline = performance.now() + ms;
  while (!test()) { if (performance.now() > deadline) throw new Error(message); await delay(30); }
}

// Only HTTP signaling is an in-memory fixture. SDP negotiation, ICE, Opus RTP,
// remote audio tracks, data channels and the recording graph are browser-native.
async function connectPhone() {
  const studio = new StudioPhoneMic();
  const phone = new RTCPeerConnection({ iceServers: [] });
  const microphoneContext = new AudioContext({ sampleRate: 48000 });
  await microphoneContext.resume();
  const voice = microphoneContext.createOscillator(); voice.frequency.value = 440;
  const gain = microphoneContext.createGain(); gain.gain.value = .25;
  const destination = microphoneContext.createMediaStreamDestination();
  voice.connect(gain); gain.connect(destination); voice.start();
  const sentTrack = destination.stream.getAudioTracks()[0];
  phone.addTrack(sentTrack, destination.stream);
  const controls = phone.createDataChannel('soundproof-controls', { ordered: true });
  const statuses: { recorder?: string; armed?: boolean }[] = [];
  controls.onmessage = event => statuses.push(JSON.parse(event.data));
  let sequence = 0;
  const studioSignals: { sequence: number; type: string; payload: unknown }[] = [];
  const addSignal = (type: string, payload: unknown) => studioSignals.push({ sequence: ++sequence, type, payload });
  const pendingCandidates: RTCIceCandidateInit[] = [];
  const nativeFetch = window.fetch.bind(window);
  const response = (data: object) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === '/api/phone/sessions') return response({ sessionId: 'rtc-test', pairingCode: '123456', inviteUrl: '/phone#inviteToken=rtc-test', expiresAt: new Date(Date.now() + 600_000).toISOString(), iceServers: [] });
    if (url.pathname === '/api/phone/sessions/rtc-test/signals') {
      if (init?.method === 'POST') {
        const signal = JSON.parse(init.body as string);
        if (signal.type === 'answer') {
          await phone.setRemoteDescription({ type: 'answer', sdp: signal.payload.sdp });
          for (const candidate of pendingCandidates.splice(0)) await phone.addIceCandidate(candidate);
        } else if (signal.type === 'ice') {
          if (phone.remoteDescription) await phone.addIceCandidate(signal.payload.candidate);
          else pendingCandidates.push(signal.payload.candidate);
        }
        return response({ ok: true });
      }
      const after = Number(url.searchParams.get('after') || 0);
      return response({ signals: studioSignals.filter(signal => signal.sequence > after), next: sequence });
    }
    if (url.pathname === '/api/phone/sessions/rtc-test' && init?.method === 'DELETE') return response({ ok: true });
    return nativeFetch(input, init);
  };
  phone.onicecandidate = event => { if (event.candidate) addSignal('ice', { candidate: event.candidate.toJSON() }); };
  await studio.createSession();
  await phone.setLocalDescription(await phone.createOffer({ offerToReceiveAudio: false }));
  addSignal('offer', { sdp: phone.localDescription!.sdp });
  await until(() => studio.getSnapshot().phase === 'connected' && controls.readyState === 'open', 'Real phone audio/control connection did not open');
  controls.send(JSON.stringify({ type: 'device', name: 'Synthetic phone over WebRTC' }));
  await until(() => studio.getSnapshot().deviceName === 'Synthetic phone over WebRTC', 'Device name did not arrive over the real data channel');
  return {
    studio, phone, controls, statuses, sentTrack, gain,
    close: async () => {
      await studio.disconnect(); phone.close(); sentTrack.stop(); voice.stop();
      await microphoneContext.close(); window.fetch = nativeFetch;
    },
  };
}

async function audioMetrics(context: AudioContext, blob: Blob) {
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const data = decoded.getChannelData(0);
  const start = Math.floor(decoded.sampleRate * .2);
  const end = Math.min(data.length, start + Math.floor(decoded.sampleRate * .8));
  let energy = 0, peak = 0;
  for (const value of data) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  // A narrow frequency measurement distinguishes transported microphone audio
  // from a backing-only take; nonzero file size/RMS alone cannot catch this bug.
  let toneAmplitude = 0;
  for (let frequency = 437; frequency <= 443; frequency += .5) {
    let real = 0, imaginary = 0;
    for (let i = start; i < end; i++) {
      const phase = 2 * Math.PI * frequency * i / decoded.sampleRate;
      real += data[i] * Math.cos(phase); imaginary += data[i] * Math.sin(phase);
    }
    toneAmplitude = Math.max(toneAmplitude, 2 * Math.hypot(real, imaginary) / (end - start));
  }
  return { seconds: decoded.duration, peak, rms: Math.sqrt(energy / data.length), microphone440Hz: toneAmplitude };
}

async function main() {
  const connection = await connectPhone();
  const engine = new AudioEngine(); engine.init(); engine.setVolume(0);
  await engine.prepare();
  const context = (engine as unknown as { ctx: AudioContext }).ctx;
  try {
    results.push({ name: 'real-webrtc-phone-audio-and-controls-connected' });
    let nextCommand: ((command: PhoneControlCommand) => void) | undefined;
    const unsubscribe = connection.studio.subscribeCommand(command => nextCommand?.(command));
    connection.studio.setArmed(true);
    await until(() => connection.statuses.some(status => status.armed), 'Armed status did not reach phone');
    for (const includeInstrumental of [false, true, false]) {
      let capture: VocalCapture | undefined;
      let takePromise: Promise<RecordedAudio | null> | undefined;
      let received: MediaStream | undefined;
      let phase = '';
      let peakLevel = 0;
      nextCommand = command => {
        if (command === 'record-start') {
          capture = new VocalCapture(engine, {
            includeInstrumental, countdownSeconds: 0,
            requireMicrophoneSignal: !baseline,
            getMicrophone: async () => { received = await connection.studio.getMicrophoneStream(); return received; },
            onLevel: value => { peakLevel = Math.max(peakLevel, value); },
            onState: value => { phase = value; if (value !== 'permission') connection.studio.sendStatus(value); },
            startBacking: () => engine.start(initialSongs[0], () => {}),
          });
          takePromise = capture.record();
          // Keep rejection handled while awaiting the remote stop in this test.
          void takePromise.catch(() => {});
        } else capture?.stop();
      };
      connection.controls.send(JSON.stringify({ type: 'record-start' }));
      await until(() => phase === 'recording', 'Data-channel start did not begin recording');
      await delay(1500);
      connection.controls.send(JSON.stringify({ type: 'record-stop' }));
      await until(() => phase === 'saving', 'Data-channel stop did not finalize recording');
      const take = await takePromise;
      check(take?.blob.size, 'Remote recording did not produce an encoded take');
      const metrics = await audioMetrics(context, take!.blob);
      results.push({ name: includeInstrumental ? 'real-webrtc-voice-with-backing' : 'real-webrtc-voice-only', details: { ...metrics, peakLevel } });
      check(metrics.microphone440Hz > .03, 'Phone voice was missing from saved recording: ' + JSON.stringify(metrics));
      check(peakLevel > .1, 'Phone microphone meter did not receive the transmitted voice');
      check(received?.getAudioTracks().every(track => track.readyState === 'ended'), 'Capture did not release its cloned audio track');
      check(connection.studio.getSnapshot().stream?.getAudioTracks().every(track => track.readyState === 'live'), 'Saving a take stopped the reusable phone stream');
      check(connection.sentTrack.readyState === 'live' && connection.controls.readyState === 'open', 'Saving disconnected phone audio or controls');
    }
    unsubscribe();
    results.push({ name: 'three-remote-takes-preserve-phone-audio-connection' });

    // A working control channel and a loud backing must not mask a silent
    // microphone. Keep actual RTP/control transport live and silence only the
    // source, as happens when a phone stops delivering microphone samples.
    connection.gain.gain.value = 0;
    await delay(700);
    let silentCapture: VocalCapture | undefined;
    let silentResult: Promise<{ audio?: RecordedAudio | null; error?: Error }> | undefined;
    let silentPhase = '';
    let silentPeak = 0;
    const stopSilentListener = connection.studio.subscribeCommand(command => {
      if (command === 'record-start') {
        silentCapture = new VocalCapture(engine, {
          includeInstrumental: true, countdownSeconds: 0, requireMicrophoneSignal: true,
          getMicrophone: connection.studio.getMicrophoneStream,
          onLevel: value => { silentPeak = Math.max(silentPeak, value); },
          onState: value => { silentPhase = value; },
          startBacking: () => engine.start(initialSongs[0], () => {}),
        });
        silentResult = silentCapture.record().then(audio => ({ audio }), error => ({ error }));
      } else silentCapture?.stop();
    });
    connection.controls.send(JSON.stringify({ type: 'record-start' }));
    await until(() => silentPhase === 'recording', 'Silent-phone control did not start recording');
    await delay(1500);
    connection.controls.send(JSON.stringify({ type: 'record-stop' }));
    await until(() => silentPhase === 'saving', 'Silent-phone control did not stop recording');
    const rejected = await silentResult;
    stopSilentListener();
    check(rejected?.error?.message.includes('No sound reached the computer'), 'Silent phone was accepted despite requireMicrophoneSignal: ' + JSON.stringify(rejected));
    check(!rejected?.audio, 'Silent phone was saved as a successful vocal take');
    check(silentPeak < .0001, 'Silence fixture still contained microphone signal');
    check(connection.controls.readyState === 'open' && connection.sentTrack.readyState === 'live', 'Silence fixture lost transport rather than only microphone samples');
    const transport = await connection.phone.getStats();
    const outboundAudio = [...transport.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'audio');
    check(outboundAudio?.packetsSent > 0 && outboundAudio?.bytesSent > 0, 'Test did not send actual audio RTP packets');
    results.push({ name: 'silent-phone-rejected-even-with-instrumental-backing', details: { silentPeak, error: rejected?.error?.message, packetsSent: outboundAudio?.packetsSent, bytesSent: outboundAudio?.bytesSent } });
  } finally { await connection.close(); await context.close(); }
  return results;
}

main().then(results => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) }))
  .catch(error => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: String(error), stack: error?.stack, results }) }));

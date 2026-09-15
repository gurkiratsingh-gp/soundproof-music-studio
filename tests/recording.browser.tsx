import React from 'react';
import { createRoot } from 'react-dom/client';
import { AudioEngine } from '../src/utils/audioEngine';
import { VocalCapture, microphoneError, recordingExtension } from '../src/utils/vocalRecording';
import { listTakes, saveTake, countTakes, deleteTake, type VocalTake } from '../src/utils/recordingStore';
import { initialSongs } from '../src/utils/initialSongs';
import SongPlayer from '../src/components/SongPlayer';
import ChatAssistant from '../src/components/ChatAssistant';
import type { PhoneControlCommand, PhoneMicState, StudioPhoneMic } from '../src/utils/phoneCompanion';

const results: { name: string; details?: unknown }[] = [];
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, message: string, ms = 7000) {
  const deadline = performance.now() + ms;
  while (!test()) { if (performance.now() > deadline) throw new Error(message); await delay(30); }
}
const engine = new AudioEngine(); engine.init(); engine.setVolume(0);
const context: AudioContext = (engine as any).ctx;
const sources: OscillatorNode[] = [];
let lastMic: MediaStream;
function syntheticMic(amplitude = .25) {
  const source = context.createOscillator(); source.frequency.value = 440;
  const gain = context.createGain(); gain.gain.value = amplitude;
  const destination = context.createMediaStreamDestination();
  source.connect(gain); gain.connect(destination); source.start(); sources.push(source);
  lastMic = destination.stream;
  return destination.stream;
}
async function metrics(blob: Blob) {
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const data = decoded.getChannelData(0);
  let peak = 0, energy = 0;
  for (const value of data) { peak = Math.max(peak, Math.abs(value)); energy += value * value; }
  return { seconds: decoded.duration, peak, rms: Math.sqrt(energy / data.length) };
}
async function captureSample(includeInstrumental: boolean, amplitude: number) {
  let mic: MediaStream | undefined; let peakLevel = 0;
  const phases: string[] = [];
  const capture = new VocalCapture(engine, { includeInstrumental, countdownSeconds: 0,
    getMicrophone: async () => { mic = syntheticMic(amplitude); return mic; },
    onLevel: value => { peakLevel = Math.max(peakLevel, value); },
    onState: phase => { phases.push(phase); if (phase === 'recording') setTimeout(() => capture.stop(), 1100); },
    startBacking: () => engine.start(initialSongs[0], () => {}),
  });
  const result = await capture.record(); check(result && result.blob.size > 500, 'No encoded recording');
  check(mic?.getTracks().every(track => track.readyState === 'ended'), 'Microphone still active after stop');
  check(phases.includes('saving'), 'Missing finishing state');
  const values = await metrics(result!.blob);
  check(values.seconds > .8 && values.peak < .95, 'Recording duration/clipping regression: ' + JSON.stringify(values));
  check(values.rms > .008, 'Recording was silent');
  if (amplitude) check(peakLevel > .1, 'Microphone meter did not read input');
  results.push({ name: includeInstrumental ? 'mixed-backing-recorded-even-with-monitor-muted' : 'native-microphone-recording-and-cleanup', details: values });
  return result!;
}
async function main() {
  await context.resume();
  const own = await captureSample(false, .25);
  await captureSample(true, 0);
  const rejected = new VocalCapture(engine, { includeInstrumental: false, getMicrophone: async () => { throw new DOMException('blocked', 'NotAllowedError'); }, onLevel: () => {}, onState: () => {}, startBacking: () => {} });
  try { await rejected.record(); throw new Error('Permission rejection ignored'); }
  catch (error) { check(microphoneError(error).includes('site settings'), 'Permission error was unclear'); }
  results.push({ name: 'permission-denied-with-actionable-message' });

  let resolveMic!: (stream: MediaStream) => void;
  const pendingMic = new Promise<MediaStream>(resolve => { resolveMic = resolve; });
  const pending = new VocalCapture(engine, { includeInstrumental: false, getMicrophone: () => pendingMic, onLevel: () => {}, onState: () => {}, startBacking: () => {} });
  const cancelled = pending.record(); pending.cancel();
  check(await cancelled === null, 'Permission cancellation did not finish promptly');
  // A newer player may already be running when the old permission dialog ends.
  engine.start(initialSongs[0], () => {});
  const lateMic = syntheticMic(); resolveMic(lateMic);
  await delay(20);
  check(lateMic.getTracks().every(track => track.readyState === 'ended'), 'Late mic grant leaked its tracks');
  check(engine.isPlaying(), 'Old cancellation stopped a newer preview'); engine.stop();
  results.push({ name: 'late-permission-grant-released-without-stopping-new-playback' });

  let disconnectedMic: MediaStream;
  const interrupted = new VocalCapture(engine, { includeInstrumental: false, countdownSeconds: 0, getMicrophone: async () => { disconnectedMic = syntheticMic(); return disconnectedMic; }, onLevel: () => {}, onState: phase => { if (phase === 'recording') setTimeout(() => { const track = disconnectedMic.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); }, 750); }, startBacking: () => {} });
  const partial = await interrupted.record(); check(partial?.interrupted && partial.blob.size > 0, 'Mic disconnect lost partial take');
  results.push({ name: 'disconnected-microphone-preserves-partial-take' });

  const take: VocalTake = { id: 'take', userId: 'alice', songId: 'song', createdAt: new Date().toISOString(), blob: own.blob, duration: own.duration, includesInstrumental: false, bpm: 90 };
  await saveTake(take);
  const restored = await listTakes('alice', 'song');
  check(restored.length === 1 && restored[0].blob.size === own.blob.size, 'Blob not restored from IndexedDB');
  check((await metrics(restored[0].blob)).rms > .01, 'Restored take did not decode');
  check((await listTakes('bob', 'song')).length === 0 && (await listTakes('alice', 'other')).length === 0, 'Takes leaked across account/song keys');
  await deleteTake('bob', 'song', 'take'); check(await countTakes('alice') === 1, 'Cross-account delete removed take');
  for (let i = 1; i < 10; i++) await saveTake({ ...take, id: 'take-' + i });
  let rejectedCap = false; try { await saveTake({ ...take, id: 'overflow' }); } catch { rejectedCap = true; }
  check(rejectedCap && await countTakes('alice') === 10, 'Take cap was not enforced');
  await deleteTake('alice', 'song', 'take'); check(await countTakes('alice') === 9, 'Deleting a take did not persist');
  results.push({ name: 'durable-blobs-account-song-isolation-and-storage-cap' });

  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => syntheticMic();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let busy = false; let saves = 0;
  const player = () => <SongPlayer song={initialSongs[0]} userId="ui-test" audioEngine={engine} musicProvider={null} onGenerateVocals={() => { throw new Error('Paid generation called'); }} onEdit={() => {}} onRecordingBusy={value => { busy = value; }} onRecorded={() => { saves++; }} onTimingChange={() => {} } />;
  root.render(player());
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text));
  await until(() => !!button('Prepare instrumental download'), 'Instrumental download control missing');
  button('Prepare instrumental download')!.click();
  await until(() => busy && container.textContent!.includes('Rendering 60-second WAV'), 'Instrumental render did not show a busy state');
  await until(() => !!container.querySelector('[download$="-instrumental.wav"]') || !!container.querySelector('.instrumental-export~[role="alert"]'), 'Instrumental WAV did not finish', 30000);
  check(!!container.querySelector('[download$="-instrumental.wav"]'), 'Instrumental WAV was not prepared: ' + (container.querySelector('.instrumental-export~[role="alert"]')?.textContent || 'unknown browser error'));
  const instrumentalLink = container.querySelector('[download$="-instrumental.wav"]') as HTMLAnchorElement;
  const instrumentalWave = new Uint8Array(await (await fetch(instrumentalLink.href)).arrayBuffer());
  check(new TextDecoder().decode(instrumentalWave.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(instrumentalWave.slice(8, 12)) === 'WAVE', 'Instrumental export was not a WAV');
  check(!busy && saves === 1, 'Instrumental export did not release the player or record activity');
  results.push({ name: 'procedural-instrumental-offline-wav-download' });
  await until(() => !!button('Record my vocals') && !button('Record my vocals')!.disabled, 'Record button not ready');
  button('Record my vocals')!.click();
  await until(() => container.textContent!.includes('Get ready'), 'Countdown missing');
  check(busy && (container.querySelector('[aria-label="Play instrumental"]') as HTMLButtonElement).disabled, 'Playback not locked during recording');
  await until(() => !!button('Stop & save'), 'Recorder did not start after countdown');
  await until(() => !!container.querySelector('.karaoke-guide.active'), 'Lyric guide did not activate with the recorded backing track');
  check(container.querySelectorAll('.beat-count .on').length === 1, 'Four-beat guide did not select one beat');
  check(container.querySelector('.karaoke-current')?.textContent?.includes('enter after 4'), 'Lyric guide omitted its count-in');
  await until(() => container.querySelector('.karaoke-current')?.textContent === initialSongs[0].lyrics[0].lines[0], 'First lyric did not follow the count-in', 5000);
  check(!!container.querySelector('.lyric-line.current[aria-current="true"]'), 'Full lyrics did not highlight the current line');
  check(container.querySelector('.karaoke-bottom')?.textContent?.includes(initialSongs[0].lyrics[0].lines[1]), 'Large guide omitted the next lyric line');
  button('Stop & save')!.click();
  await until(() => !busy && saves === 2, 'Take did not save');
  check(lastMic.getTracks().every(track => track.readyState === 'ended'), 'UI left microphone on');
  await until(() => button('My take')?.getAttribute('aria-pressed') === 'true', 'Player did not select my take');
  const download = container.querySelector('[aria-label="Download selected recording"]') as HTMLAnchorElement;
  check(download.href.startsWith('blob:') && download.download.endsWith('.' + recordingExtension(own.blob.type)), 'Download has wrong URL/extension');
  (container.querySelector('[aria-label="Play recording"]') as HTMLButtonElement).click();
  await until(() => !!container.querySelector('[aria-label="Pause recording"]'), 'Saved recording did not play');
  root.render(<div />); await delay(80); root.render(player());
  await until(() => !!button('My take') && !button('My take')!.disabled, 'Saved take not restored after remount');
  button('Instrumental')!.click();
  await until(() => !!container.querySelector('[aria-label="Play instrumental"]'), 'Instrumental mode not selected');
  (container.querySelector('[aria-label="Play instrumental"]') as HTMLButtonElement).click();
  await until(() => !!container.querySelector('.karaoke-guide.active .karaoke-current'), 'Lyric guide did not activate with instrumental playback');
  await until(() => !!container.querySelector('.lyrics-content.is-following .lyric-line.current'), 'Instrumental did not color the lyric sheet', 5000);
  (container.querySelector('[aria-label="Stop playback"]') as HTMLButtonElement).click();
  await until(() => !container.querySelector('.karaoke-guide.active'), 'Stopping playback did not reset lyric guide');
  button('My take')!.click(); await until(() => !!container.querySelector('[aria-label="Play recording"]'), 'Restored take not selected');
  results.push({ name: 'record-countdown-save-player-download-remount' });

  root.render(<div />); await delay(80);
  const remoteSource = syntheticMic(.2);
  const phoneListeners = new Set<() => void>();
  const phoneCommands = new Set<(command: PhoneControlCommand) => void>();
  const phoneStatuses: string[] = [];
  let phoneState: PhoneMicState = { phase: 'idle', armed: false };
  let phoneStreamRequests = 0;
  let phoneCreates = 0;
  let phoneDisconnects = 0;
  const publishPhoneState = (next: PhoneMicState) => { phoneState = next; phoneListeners.forEach(listener => listener()); };
  const fakePhone = {
    getSnapshot: () => phoneState,
    subscribe: (listener: () => void) => { phoneListeners.add(listener); return () => { phoneListeners.delete(listener); }; },
    subscribeCommand: (listener: (command: PhoneControlCommand) => void) => { phoneCommands.add(listener); return () => { phoneCommands.delete(listener); }; },
    createSession: async () => {
      phoneCreates++;
      publishPhoneState({ phase: 'waiting', armed: false, sessionId: 'phone-session', pairingCode: phoneCreates === 1 ? '123456' : '654321', inviteUrl: `${location.origin}/phone#inviteToken=test-${phoneCreates}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    },
    disconnect: async () => { phoneDisconnects++; publishPhoneState({ phase: 'idle', armed: false }); },
    setArmed: (armed: boolean) => { publishPhoneState({ ...phoneState, armed }); },
    sendStatus: (status: string) => { phoneStatuses.push(status); },
    getMicrophoneStream: async () => { phoneStreamRequests++; return new MediaStream(remoteSource.getAudioTracks().map(track => track.clone())); },
  } as unknown as StudioPhoneMic;
  let phoneSaves = 0;
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Computer microphone should not be requested for phone source'); };
  root.render(<SongPlayer song={initialSongs[1]} userId="phone-test" audioEngine={engine} phoneMic={fakePhone} onEdit={() => {}} onRecordingBusy={() => {}} onRecorded={() => { phoneSaves++; }} onTimingChange={() => {}} />);
  await until(() => !!button('Create phone connection'), 'Phone pairing was not available inside the vocal recorder');
  check(!!container.querySelector('.vocal-recorder .phone-mic-panel.compact'), 'Recorder did not use the compact phone pairing panel');
  button('Create phone connection')!.click();
  await until(() => container.textContent!.includes('123456') && !!button('Copy private link') && !!button('New code') && !!button('Disconnect phone'), 'Inline pairing did not show its code and connection actions');
  button('New code')!.click();
  await until(() => phoneCreates === 2 && container.textContent!.includes('654321'), 'Inline pairing could not create a fresh code');
  publishPhoneState({ phase: 'connected', armed: false, sessionId: 'phone-session', deviceName: 'Test phone', stream: remoteSource });
  await until(() => !!button('Phone microphone') && !button('Phone microphone')!.disabled, 'Connected phone microphone was not offered');
  button('Phone microphone')!.click();
  await until(() => button('Phone microphone')?.getAttribute('aria-pressed') === 'true' && !!button('Arm start / stop on phone'), 'Phone microphone source was not selected'); button('Arm start / stop on phone')!.click();
  await until(() => phoneState.armed && container.textContent!.includes('Phone controls armed'), 'Phone controls did not enter the armed state');
  check(phoneCommands.size === 1, 'Recorder did not subscribe to phone controls');
  phoneCommands.forEach(listener => listener('record-start'));
  await until(() => !!button('Stop & save') || !!container.querySelector('.vocal-recorder [role="alert"]'), 'Remote phone start did not update the recorder', 7000);
  check(!!button('Stop & save'), 'Remote phone start failed: ' + (container.querySelector('.vocal-recorder [role="alert"]')?.textContent || container.textContent));
  await delay(700);
  phoneCommands.forEach(listener => listener('record-stop'));
  await until(() => phoneSaves === 1 && container.textContent!.includes('Take saved'), 'Remote phone stop did not save the take', 7000);
  check(phoneStreamRequests === 1, 'Recorder did not use the paired phone stream');
  check(remoteSource.getAudioTracks().every(track => track.readyState === 'live'), 'Saving a take stopped the persistent WebRTC source');
  check(phoneStatuses.includes('recording') && phoneStatuses.includes('saving') && phoneStatuses.at(-1) === 'idle', 'Recorder state was not returned to the phone');
  button('Disconnect phone')!.click();
  await until(() => phoneDisconnects === 1 && !!button('Create phone connection'), 'Phone could not be disconnected from the vocal recorder');
  results.push({ name: 'inline-phone-pairing-remote-start-stop-disconnect-and-track-cloning' });

  root.render(<div />); await delay(80);
  navigator.mediaDevices.getUserMedia = async () => syntheticMic();
  const realSave = window.indexedDB.open.bind(window.indexedDB);
  window.indexedDB.open = () => { throw new Error('Storage denied by test'); };
  root.render(player());
  await until(() => !!button('Record my vocals') && !button('Record my vocals')!.disabled, 'Storage failure blocked recording');
  button('Record my vocals')!.click();
  await until(() => !!button('Stop & save'), 'Unsaved recorder did not start'); await delay(650); button('Stop & save')!.click();
  await until(() => container.textContent!.includes('only in memory') && !busy, 'Unsaved take was falsely labelled saved');
  check(!!container.querySelector('[aria-label="Download my vocal take"]'), 'Storage failure lost download');
  window.indexedDB.open = realSave;
  results.push({ name: 'storage-denied-retains-downloadable-take' });
  root.render(<div />); await delay(80);
  navigator.mediaDevices.getUserMedia = nativeGetUserMedia;

  const voiceOnly: VocalTake = { ...take, id: 'voice-only', userId: 'mixer-test', songId: initialSongs[0].id, createdAt: new Date().toISOString(), blob: own.blob, duration: own.duration, includesInstrumental: false, bpm: initialSongs[0].bpm };
  await saveTake(voiceOnly);
  let mixedBusy = false;
  root.render(<SongPlayer song={initialSongs[0]} userId="mixer-test" audioEngine={engine} musicProvider={null} onGenerateVocals={() => {}} onEdit={() => {}} onRecordingBusy={value => { mixedBusy = value; }} onRecorded={() => {}} onTimingChange={() => {}} />);
  await until(() => !!button('Preview mix'), 'Vocal Studio mixer did not open for a saved take');
  await until(() => container.querySelectorAll('.mix-waveform>span:not(.waveform-loading)').length > 20, 'Waveform was not decoded');
  const instrumentalSlider = [...container.querySelectorAll('.mix-controls label')].find(label => label.textContent?.includes('Instrumental'))?.querySelector('input') as HTMLInputElement;
  check(instrumentalSlider && !instrumentalSlider.disabled, 'Voice-only take did not unlock separate instrumental volume');
  const tone = [...container.querySelectorAll('.mix-controls label')].find(label => label.textContent?.includes('Vocal tone'))?.querySelector('input') as HTMLInputElement;
  button('Enhance voice')!.click();
  await until(() => tone.closest('label')?.textContent?.includes('+4 dB') === true, 'Enhanced voice preset did not brighten the vocal');
  check(instrumentalSlider.value === '45', 'Enhanced voice preset did not bring the voice forward in the mix');
  check(container.textContent!.includes('Enhanced voice preset applied'), 'Enhanced voice preset did not explain its result');
  (container.querySelector('[aria-label="Save mix settings"]') as HTMLButtonElement).click();
  await until(() => container.textContent!.includes('Mix settings saved'), 'Mixer preset was not saved');
  check((await listTakes('mixer-test', initialSongs[0].id))[0].mix?.tone === 4, 'Saved mixer settings were not persisted');
  button('Preview mix')!.click(); await until(() => !!button('Stop preview') && mixedBusy, 'Separate vocal/instrumental preview did not start');
  check(engine.isPlaying(), 'Procedural backing did not play with voice-only take'); button('Stop preview')!.click(); await until(() => !mixedBusy, 'Mixer preview did not stop');
  button('Export final WAV')!.click(); await until(() => !!button('Cancel export'), 'WAV export did not start');
  await until(() => !!container.querySelector('[download$="-final-mix.wav"]'), 'WAV export did not finish', 10000);
  const wavDownload = container.querySelector('[download$="-final-mix.wav"]') as HTMLAnchorElement;
  const wav = new Uint8Array(await (await fetch(wavDownload.href)).arrayBuffer());
  check(new TextDecoder().decode(wav.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(wav.slice(8, 12)) === 'WAVE', 'Export was not a real WAV file');
  results.push({ name: 'vocal-studio-enhance-voice-waveform-separate-levels-effects-preview-preset-wav-export' });
  root.render(<div />); await delay(80);

  const timingSong = { ...initialSongs[0], id: 'timing-song', lyrics: [{ section: 'Verse', lines: ['First line', 'Second line'] }], lyricTiming: undefined };
  let savedTiming: number[] | undefined;
  root.render(<SongPlayer song={timingSong} userId="timing-test" audioEngine={engine} musicProvider={null} onGenerateVocals={() => {}} onEdit={() => {}} onRecordingBusy={() => {}} onRecorded={() => {}} onTimingChange={value => { savedTiming = value; }} />);
  await until(() => !!button('Set custom timing'), 'Manual timing editor was not available'); button('Set custom timing')!.click();
  await until(() => !!button('Tap line 1'), 'Timing preview did not start'); button('Tap line 1')!.click(); await delay(220); button('Tap line 2')!.click();
  await until(() => !!savedTiming, 'Manual timing was not saved');
  check(savedTiming!.length === 2 && savedTiming![1] > savedTiming![0], 'Manual timings were invalid');
  results.push({ name: 'manual-two-line-timing-capture' });
  root.render(<div />); await delay(80);

  // Fixture chat interaction exercises draft memory, revised-save controls and
  // follow-up suggestions without calling Gemini or using any real recording.
  const nativeFetch = window.fetch;
  const requests: any[] = [];
  let applied = false;
  const draft = { ...initialSongs[0], title: 'A new chorus' };
  window.fetch = async (input, init) => {
    if (input === '/api/chat') {
      requests.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ reply: 'Here is the chorus.', ideas: [], draft, changes: ['Shortened the chorus'], followUps: ['Keep the verses and soften the chorus'] }), { headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(input, init);
  };
  let matched: any;
  root.render(<ChatAssistant song={initialSongs[0]} userId="mixer-test" onDraft={() => {}} onApply={() => { applied = true; }} onAudioInstrumental={draft => { matched = draft; }} onActivity={() => {}} />);
  await until(() => !!button('Add sung audio'), 'Chat audio attachment control missing'); button('Add sung audio')!.click();
  await until(() => !!button('Use saved take'), 'Saved vocal take was not offered to chat'); button('Use saved take')!.click();
  await until(() => !!button('Generate matched instrumental'), 'Saved vocal take was not analyzed', 10000);
  check(!!container.querySelector('.audio-reference-player') && container.textContent!.includes('PITCH CENTER'), 'Chat audio preview or analysis summary missing');
  button('Generate matched instrumental')!.click();
  check(matched?.bpm >= 40 && matched?.bpm <= 240 && /(?:major|minor)$/.test(matched?.key || ''), 'Audio analysis did not produce a usable backing draft');
  results.push({ name: 'chat-saved-audio-local-analysis-and-matched-instrumental-draft' });
  await until(() => !!button('Change the feeling'), 'Chat starters missing'); button('Change the feeling')!.click();
  await until(() => !(container.querySelector('[aria-label="Send message to Kavi"]') as HTMLButtonElement).disabled, 'Starter prompt not applied');
  (container.querySelector('[aria-label="Send message to Kavi"]') as HTMLButtonElement).click();
  await until(() => !!button('Keep the verses'), 'Follow-up suggestions missing');
  button('Keep the verses')!.click();
  await until(() => !(container.querySelector('[aria-label="Send message to Kavi"]') as HTMLButtonElement).disabled, 'Follow-up prompt not applied');
  (container.querySelector('[aria-label="Send message to Kavi"]') as HTMLButtonElement).click();
  await until(() => requests.length === 2, 'Follow-up not sent');
  check(requests[1].latestDraft?.title === draft.title && requests[1].latestDraft.lyrics.length, 'Chat lost draft-card lyrics');
  button('Save revised song')!.click(); check(applied, 'Revision action failed');
  results.push({ name: 'chat-follow-up-carries-latest-draft-and-revision-action' });
  root.unmount(); window.fetch = nativeFetch;
  sources.forEach(source => { try { source.stop(); source.disconnect(); } catch {} });
  await context.close();
  return results;
}
main().then(results => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) }))
  .catch(error => fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: String(error), stack: error?.stack, results }) }));

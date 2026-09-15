import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const baseline = process.argv.includes('--baseline');
const recording = process.argv.includes('--recording');
const directory = path.resolve(recording ? '.data/recording-quality' : '.data/audio-quality');
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(path.join(directory, 'browser-'));
const browser = process.env.AUDIO_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!browser) throw new Error('Set AUDIO_TEST_BROWSER to a Chromium browser executable.');
const entryPoint = path.resolve(recording ? 'tests/recording.browser.tsx' : 'tests/audio-render.browser.ts');
const bundle = await build({ entryPoints: [entryPoint], absWorkingDir: process.cwd(), bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } });
let resolveResult, rejectResult;
const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST') {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Test result too large'); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      if (request.url === '/result') { resolveResult(JSON.parse(body.toString())); response.end('ok'); }
      else if (request.url === '/audio') { await writeFile(path.join(directory, baseline ? 'before.wav' : 'after.wav'), body); response.end('ok'); }
      else { response.statusCode = 404; response.end(); }
    } else if (request.url === '/test.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Offline audio regression test</title><script src="/test.js"></script>'); }
  } catch (error) { response.statusCode = 500; response.end('Test failed'); rejectResult(error); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const processHandle = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--mute-audio', ...(recording ? ['--autoplay-policy=no-user-gesture-required'] : []), '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port + (baseline ? '/?baseline=1' : '/')], { windowsHide: true, stdio: 'ignore' });
processHandle.once('error', rejectResult);
const timeout = setTimeout(() => rejectResult(new Error('Offline audio test timed out.')), recording ? 60_000 : 45_000);
try {
  const report = await result;
  await writeFile(path.join(directory, baseline ? 'before.json' : 'after.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  processHandle.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Only the isolated test profile beneath this exact workspace directory is removed.
  if (!path.resolve(profile).startsWith(directory + path.sep)) throw new Error('Invalid test profile cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
}

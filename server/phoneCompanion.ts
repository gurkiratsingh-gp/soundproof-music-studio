import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';

export type PhoneMicIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export const DEFAULT_PHONE_MIC_ICE_SERVERS: readonly PhoneMicIceServer[] = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
]);

export const PHONE_COMPANION_LIMITS = Object.freeze({
  sessionTtlMs: 10 * 60_000,
  connectedTtlMs: 60 * 60_000,
  maxActiveSessions: 100,
  maxActiveSessionsPerOwner: 4,
  maxSignalsPerSession: 96,
  maxSignalBytesPerSession: 256 * 1024,
  maxSignalBytes: 20 * 1024,
  maxSignalsPerPoll: 32,
  createAttemptsPerTenMinutes: 8,
  joinAttemptsPerTenMinutes: 12,
  pairingAttemptsPerTenMinutes: 6,
  signalWritesPerMinute: 120,
  signalReadsPerMinute: 180,
});

type ControlAction = 'ready' | 'start' | 'stop' | 'mute' | 'unmute' | 'disconnect' | 'ping' | 'pong';
const CONTROL_ACTIONS = new Set<ControlAction>(['ready', 'start', 'stop', 'mute', 'unmute', 'disconnect', 'ping', 'pong']);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE = /^\d{6}$/;

type Role = 'studio' | 'phone';
type SignalContent =
  | { type: 'offer' | 'answer'; payload: { sdp: string } }
  | { type: 'ice'; payload: { candidate: null | { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } } }
  | { type: 'control'; payload: { action: ControlAction } };

type StoredSignal = {
  id: number;
  from: Role;
  to: Role;
  createdAt: number;
  bytes: number;
  content: SignalContent;
};

type CompanionSession = {
  id: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  inviteDigest?: string;
  pairingDigest?: string;
  phoneDigest?: string;
  joinedAt?: number;
  nextSignalId: number;
  signalBytes: number;
  signals: StoredSignal[];
  evictedThrough: Record<Role, number>;
};

type RateBucket = { count: number; resetsAt: number };

export type PhoneCompanionOptions = {
  requireUser: RequestHandler;
  iceServers?: readonly PhoneMicIceServer[];
  publicSiteUrl?: string;
  now?: () => number;
  sessionTtlMs?: number;
};

class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RequestError(400, 'The request contains unsupported fields.');
}

function safeIceText(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`PHONE_MIC_ICE_SERVERS has an invalid ${name}.`);
  }
  return value;
}

function normalizeIceServers(value: unknown): PhoneMicIceServer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('PHONE_MIC_ICE_SERVERS must be a JSON array containing 1–4 ICE servers.');
  }
  return value.map((item, serverIndex) => {
    if (!isRecord(item)) throw new Error(`PHONE_MIC_ICE_SERVERS entry ${serverIndex + 1} must be an object.`);
    if (Object.keys(item).some(key => !['urls', 'username', 'credential'].includes(key))) {
      throw new Error(`PHONE_MIC_ICE_SERVERS entry ${serverIndex + 1} contains unsupported fields.`);
    }
    const values = typeof item.urls === 'string' ? [item.urls] : item.urls;
    if (!Array.isArray(values) || values.length < 1 || values.length > 4 || values.some(url => typeof url !== 'string')) {
      throw new Error(`PHONE_MIC_ICE_SERVERS entry ${serverIndex + 1} needs 1–4 URLs.`);
    }
    const urls = values.map(url => {
      const clean = url.trim();
      if (!/^(?:stun|stuns|turn|turns):[^\s@]{1,500}$/i.test(clean) || /[\u0000-\u001f\u007f]/.test(clean)) {
        throw new Error(`PHONE_MIC_ICE_SERVERS entry ${serverIndex + 1} has an invalid STUN or TURN URL.`);
      }
      return clean;
    });
    const usesTurn = urls.some(url => /^turns?:/i.test(url));
    const username = safeIceText(item.username, 'username', usesTurn);
    const credential = safeIceText(item.credential, 'credential', usesTurn);
    return {
      urls: typeof item.urls === 'string' ? urls[0] : urls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    };
  });
}

/** Parse the standard RTCIceServer JSON supplied by the deployment environment. */
export function parsePhoneMicIceServers(value?: string): PhoneMicIceServer[] {
  if (!value?.trim()) return DEFAULT_PHONE_MIC_ICE_SERVERS.map(server => ({ ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls }));
  if (byteLength(value) > 8 * 1024) throw new Error('PHONE_MIC_ICE_SERVERS must be no larger than 8 KB.');
  try { return normalizeIceServers(JSON.parse(value)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('PHONE_MIC_ICE_SERVERS must contain valid JSON.');
    throw error;
  }
}

function validateSignalEnvelope(value: unknown): { role: Role; content: SignalContent } {
  if (!isRecord(value) || (value.role !== 'studio' && value.role !== 'phone') || typeof value.type !== 'string' || !isRecord(value.payload)) {
    throw new RequestError(400, 'Choose a role and a valid WebRTC signaling message.');
  }
  exactKeys(value, ['role', 'type', 'payload']);
  const role = value.role;
  const payload = value.payload;
  if (value.type === 'offer' || value.type === 'answer') {
    exactKeys(payload, ['sdp']);
    if (typeof payload.sdp !== 'string' || !/^v=0(?:\r?\n|$)/.test(payload.sdp) || byteLength(payload.sdp) > 16 * 1024) {
      throw new RequestError(400, 'The WebRTC session description is invalid or too large.');
    }
    return { role, content: { type: value.type, payload: { sdp: payload.sdp } } };
  }
  if (value.type === 'ice') {
    exactKeys(payload, ['candidate']);
    if (payload.candidate === null) return { role, content: { type: 'ice', payload: { candidate: null } } };
    if (!isRecord(payload.candidate)) throw new RequestError(400, 'The ICE candidate is invalid.');
    exactKeys(payload.candidate, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
    const candidate = payload.candidate.candidate;
    const sdpMid = payload.candidate.sdpMid;
    const line = payload.candidate.sdpMLineIndex;
    const usernameFragment = payload.candidate.usernameFragment;
    if (typeof candidate !== 'string' || byteLength(candidate) > 4096 || /[\u0000\r\n]/.test(candidate) ||
        (sdpMid !== undefined && sdpMid !== null && (typeof sdpMid !== 'string' || sdpMid.length > 64 || /[\u0000-\u001f\u007f]/.test(sdpMid))) ||
        (line !== undefined && line !== null && (!Number.isInteger(line) || (line as number) < 0 || (line as number) > 64)) ||
        (usernameFragment !== undefined && usernameFragment !== null && (typeof usernameFragment !== 'string' || usernameFragment.length > 256 || /[\u0000-\u001f\u007f]/.test(usernameFragment)))) {
      throw new RequestError(400, 'The ICE candidate is invalid or too large.');
    }
    return { role, content: { type: 'ice', payload: { candidate: {
      candidate,
      ...(sdpMid !== undefined ? { sdpMid: sdpMid as string | null } : {}),
      ...(line !== undefined ? { sdpMLineIndex: line as number | null } : {}),
      ...(usernameFragment !== undefined ? { usernameFragment: usernameFragment as string | null } : {}),
    } } } };
  }
  if (value.type === 'control') {
    exactKeys(payload, ['action']);
    if (typeof payload.action !== 'string' || !CONTROL_ACTIONS.has(payload.action as ControlAction)) throw new RequestError(400, 'Choose a supported phone-microphone control action.');
    return { role, content: { type: 'control', payload: { action: payload.action as ControlAction } } };
  }
  throw new RequestError(400, 'Choose an offer, answer, ICE candidate, or control message.');
}

function cleanPairingCode(value: unknown) {
  return typeof value === 'string' && value.length <= 16 ? value.replace(/[ -]/g, '') : '';
}

function requestIp(req: Request) {
  const value = req.ip || req.socket.remoteAddress || 'unknown';
  return value.slice(0, 128);
}

function bearerToken(req: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') || '');
  return match?.[1] || '';
}

function afterCursor(req: Request) {
  const raw = req.query.after;
  if (raw === undefined || raw === '') return 0;
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) throw new RequestError(400, 'The signaling cursor is invalid.');
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RequestError(400, 'The signaling cursor is invalid.');
  return cursor;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: 'Phone microphone signaling is temporarily unavailable.' });
}

/**
 * Memory-only signaling for pairing a signed-in studio with one phone. It stores
 * small WebRTC negotiation messages, never media, and loses all state on restart.
 */
export function createPhoneCompanionRouter(options: PhoneCompanionOptions) {
  if (!options?.requireUser) throw new Error('Phone companion signaling requires the studio authentication middleware.');
  const router = Router();
  const now = options.now || Date.now;
  const ttlMs = options.sessionTtlMs ?? PHONE_COMPANION_LIMITS.sessionTtlMs;
  const connectedTtlMs = options.sessionTtlMs ?? PHONE_COMPANION_LIMITS.connectedTtlMs;
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new Error('Phone companion session expiry must be between 1 second and 30 minutes.');
  const iceServers = normalizeIceServers(options.iceServers || DEFAULT_PHONE_MIC_ICE_SERVERS);
  let publicOrigin = '';
  if (options.publicSiteUrl?.trim()) {
    try {
      const configured = new URL(options.publicSiteUrl.trim());
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error();
      publicOrigin = configured.origin;
    } catch { throw new Error('PUBLIC_SITE_URL must be a valid HTTP or HTTPS URL before phone microphone invitations can be created.'); }
  }
  const pepper = randomBytes(32);
  const sessions = new Map<string, CompanionSession>();
  const invites = new Map<string, string>();
  const pairings = new Map<string, string>();
  const rates = new Map<string, RateBucket>();
  const digest = (kind: string, value: string) => createHmac('sha256', pepper).update(`${kind}:${value}`).digest('hex');

  const removeSession = (session: CompanionSession) => {
    sessions.delete(session.id);
    if (session.inviteDigest) invites.delete(session.inviteDigest);
    if (session.pairingDigest) pairings.delete(session.pairingDigest);
    session.signals.length = 0;
    session.signalBytes = 0;
    session.inviteDigest = undefined;
    session.pairingDigest = undefined;
    session.phoneDigest = undefined;
  };
  const cleanup = () => {
    const time = now();
    for (const session of sessions.values()) if (session.expiresAt <= time) removeSession(session);
    for (const [key, rate] of rates) if (rate.resetsAt <= time) rates.delete(key);
  };
  const consume = (res: Response, key: string, limit: number, windowMs: number, message: string) => {
    const time = now();
    const existing = rates.get(key);
    const rate = !existing || existing.resetsAt <= time ? { count: 0, resetsAt: time + windowMs } : existing;
    rates.set(key, rate);
    rate.count++;
    if (rate.count <= limit) return true;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetsAt - time) / 1000))));
    res.status(429).json({ error: message });
    return false;
  };
  const publicSession = (session: CompanionSession) => ({
    sessionId: session.id,
    status: session.phoneDigest ? 'connected' : 'waiting',
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ...(session.joinedAt ? { joinedAt: session.joinedAt } : {}),
    iceServers,
  });
  const createInviteUrl = (req: Request, inviteToken: string) => {
    let origin = publicOrigin;
    if (!origin) {
      try { origin = new URL(`${req.protocol}://${req.get('host') || ''}`).origin; }
      catch { throw new RequestError(500, 'The server could not create a phone microphone invitation URL.'); }
    }
    const url = new URL('/phone', origin);
    // The fragment is handled by the phone page and is not sent in HTTP logs or Referer headers.
    url.hash = new URLSearchParams({ inviteToken }).toString();
    return url.toString();
  };
  const ownedSession = (req: Request, res: Response) => {
    const id = req.params.sessionId;
    const session = typeof id === 'string' && SESSION_ID.test(id) ? sessions.get(id) : undefined;
    if (!session || session.ownerId !== res.locals.user?.id) {
      res.status(404).json({ error: 'This phone microphone session was not found or has expired.' });
      return null;
    }
    return session;
  };
  const authenticatedPhone = (req: Request, res: Response) => {
    const id = req.params.sessionId;
    const session = typeof id === 'string' && SESSION_ID.test(id) ? sessions.get(id) : undefined;
    if (!session) {
      res.status(404).json({ error: 'This phone microphone session was not found or has expired.' });
      return null;
    }
    const token = bearerToken(req);
    if (!token || !session.phoneDigest || digest('phone', token) !== session.phoneDigest) {
      res.status(401).json({ error: 'The phone microphone connection is not authorized.' });
      return null;
    }
    return session;
  };
  const appendSignal = (session: CompanionSession, from: Role, content: SignalContent) => {
    const serialized = JSON.stringify(content);
    const bytes = byteLength(serialized);
    if (bytes > PHONE_COMPANION_LIMITS.maxSignalBytes) throw new RequestError(413, 'The signaling message is too large.');
    const to: Role = from === 'studio' ? 'phone' : 'studio';
    const signal: StoredSignal = { id: session.nextSignalId++, from, to, createdAt: now(), bytes, content };
    session.signals.push(signal); session.signalBytes += bytes;
    while (session.signals.length > PHONE_COMPANION_LIMITS.maxSignalsPerSession || session.signalBytes > PHONE_COMPANION_LIMITS.maxSignalBytesPerSession) {
      const removed = session.signals.shift();
      if (!removed) break;
      session.signalBytes -= removed.bytes;
      session.evictedThrough[removed.to] = Math.max(session.evictedThrough[removed.to], removed.id);
    }
    return signal.id;
  };
  const pollSignals = (session: CompanionSession, role: Role, cursor: number) => {
    const pending = session.signals.filter(signal => signal.to === role && signal.id > cursor);
    const selected = pending.slice(0, PHONE_COMPANION_LIMITS.maxSignalsPerPoll);
    const latest = session.nextSignalId - 1;
    const nextCursor = selected.length ? selected[selected.length - 1].id : latest;
    return {
      signals: selected.map(signal => ({ sequence: signal.id, type: signal.content.type, payload: signal.content.payload })),
      next: nextCursor,
      hasMore: pending.length > selected.length,
      truncated: cursor < session.evictedThrough[role],
      expiresAt: session.expiresAt,
    };
  };
  const withSignalSession = (req: Request, res: Response, role: Role, action: (session: CompanionSession, credential: string) => void) => {
    if (role === 'phone') {
      const session = authenticatedPhone(req, res);
      if (session) action(session, session.phoneDigest!);
      return;
    }
    options.requireUser(req, res, () => {
      const session = ownedSession(req, res);
      if (session) action(session, res.locals.user.id);
    });
  };

  router.use((_req, res, next) => {
    cleanup();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.post('/join', (req, res) => {
    const ip = requestIp(req);
    if (!consume(res, `join:${ip}`, PHONE_COMPANION_LIMITS.joinAttemptsPerTenMinutes, 10 * 60_000, 'Too many phone pairing attempts. Wait 10 minutes and try again.')) return;
    try {
      if (!isRecord(req.body)) throw new RequestError(400, 'Enter an invite token or six-digit pairing code.');
      exactKeys(req.body, ['inviteToken', 'pairingCode']);
      const hasInvite = req.body.inviteToken !== undefined;
      const hasPairing = req.body.pairingCode !== undefined;
      if (hasInvite === hasPairing) throw new RequestError(400, 'Enter either an invite token or a pairing code.');
      let sessionId = '';
      if (hasInvite) {
        if (typeof req.body.inviteToken !== 'string' || !SECRET_TOKEN.test(req.body.inviteToken)) throw new RequestError(400, 'The phone invite token is invalid.');
        sessionId = invites.get(digest('invite', req.body.inviteToken)) || '';
      } else {
        if (!consume(res, `pair:${ip}`, PHONE_COMPANION_LIMITS.pairingAttemptsPerTenMinutes, 10 * 60_000, 'Too many pairing-code attempts. Wait 10 minutes and try again.')) return;
        const code = cleanPairingCode(req.body.pairingCode);
        if (!PAIRING_CODE.test(code)) throw new RequestError(400, 'Enter the six-digit pairing code shown in SoundProof.');
        sessionId = pairings.get(digest('pairing', code)) || '';
      }
      const session = sessions.get(sessionId);
      if (!session) throw new RequestError(404, 'The phone microphone invitation was not found or has expired.');
      if (session.phoneDigest) throw new RequestError(409, 'A phone is already connected to this microphone session.');
      const deviceToken = randomBytes(32).toString('base64url');
      session.phoneDigest = digest('phone', deviceToken);
      session.joinedAt = now();
      // The invitation is deliberately brief. Once its one-time secret has
      // been consumed, keep the authenticated recording connection useful for
      // a full studio session without leaving it alive indefinitely.
      session.expiresAt = now() + connectedTtlMs;
      if (session.inviteDigest) invites.delete(session.inviteDigest);
      if (session.pairingDigest) pairings.delete(session.pairingDigest);
      session.inviteDigest = undefined; session.pairingDigest = undefined;
      res.json({ ...publicSession(session), deviceToken });
    } catch (error) { sendError(res, error); }
  });

  router.post('/sessions', options.requireUser, (req, res) => {
    const ownerId = res.locals.user?.id;
    if (!ownerId) return res.status(401).json({ error: 'Please sign in again to connect a phone microphone.' });
    if (!consume(res, `create:${ownerId}`, PHONE_COMPANION_LIMITS.createAttemptsPerTenMinutes, 10 * 60_000, 'Too many phone microphone sessions were created. Wait 10 minutes and try again.')) return;
    try {
      if (!isRecord(req.body) || Object.keys(req.body).length) throw new RequestError(400, 'Create a phone microphone session with an empty JSON object.');
      if (sessions.size >= PHONE_COMPANION_LIMITS.maxActiveSessions) throw new RequestError(503, 'The demo server has reached its phone microphone session limit. Try again after an older session expires.');
      if ([...sessions.values()].filter(session => session.ownerId === ownerId).length >= PHONE_COMPANION_LIMITS.maxActiveSessionsPerOwner) {
        throw new RequestError(429, 'This account already has four active phone microphone sessions. Close one before creating another.');
      }
      const id = randomUUID();
      const inviteToken = randomBytes(32).toString('base64url');
      let pairingCode = ''; let pairingDigest = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        pairingCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
        pairingDigest = digest('pairing', pairingCode);
        if (!pairings.has(pairingDigest)) break;
        pairingCode = '';
      }
      if (!pairingCode) throw new RequestError(503, 'A unique phone pairing code is temporarily unavailable. Try again.');
      const inviteDigest = digest('invite', inviteToken);
      const createdAt = now();
      const session: CompanionSession = { id, ownerId, createdAt, expiresAt: createdAt + ttlMs, inviteDigest, pairingDigest, nextSignalId: 1, signalBytes: 0, signals: [], evictedThrough: { studio: 0, phone: 0 } };
      const inviteUrl = createInviteUrl(req, inviteToken);
      sessions.set(id, session); invites.set(inviteDigest, id); pairings.set(pairingDigest, id);
      res.status(201).json({ ...publicSession(session), pairingCode, inviteUrl });
    } catch (error) { sendError(res, error); }
  });

  router.get('/sessions/:sessionId', options.requireUser, (req, res) => {
    const session = ownedSession(req, res); if (!session) return;
    if (!consume(res, `read:studio:${session.id}:${res.locals.user.id}`, PHONE_COMPANION_LIMITS.signalReadsPerMinute, 60_000, 'Too many phone microphone checks. Wait a minute and try again.')) return;
    const queuedForStudio = session.signals.filter(signal => signal.to === 'studio').length;
    const queuedForPhone = session.signals.filter(signal => signal.to === 'phone').length;
    res.json({ ...publicSession(session), queuedForStudio, queuedForPhone });
  });

  router.delete('/sessions/:sessionId', options.requireUser, (req, res) => {
    const session = ownedSession(req, res); if (!session) return;
    removeSession(session);
    res.status(204).end();
  });

  // A paired phone has no studio login cookie, so it uses its one-time device
  // credential to retire the consumed session when the user disconnects. This
  // prevents an abandoned session from occupying an owner slot for an hour.
  router.delete('/sessions/:sessionId/phone', (req, res) => {
    const session = authenticatedPhone(req, res); if (!session) return;
    removeSession(session);
    res.status(204).end();
  });

  router.post('/sessions/:sessionId/signals', (req, res) => {
    try {
      const signal = validateSignalEnvelope(req.body);
      withSignalSession(req, res, signal.role, (session, credential) => {
        const suffix = signal.role === 'phone' ? `${credential}:${requestIp(req)}` : credential;
        if (!consume(res, `write:${signal.role}:${session.id}:${suffix}`, PHONE_COMPANION_LIMITS.signalWritesPerMinute, 60_000, 'Too many signaling messages. Wait a minute and reconnect.')) return;
        res.status(202).json({ accepted: true, sequence: appendSignal(session, signal.role, signal.content) });
      });
    } catch (error) { sendError(res, error); }
  });

  router.get('/sessions/:sessionId/signals', (req, res) => {
    const role = req.query.role;
    if (role !== 'studio' && role !== 'phone') return res.status(400).json({ error: 'Choose the studio or phone signaling role.' });
    try {
      const cursor = afterCursor(req);
      withSignalSession(req, res, role, (session, credential) => {
        const suffix = role === 'phone' ? `${credential}:${requestIp(req)}` : credential;
        if (!consume(res, `poll:${role}:${session.id}:${suffix}`, PHONE_COMPANION_LIMITS.signalReadsPerMinute, 60_000, 'Too many signaling polls. Wait a minute and reconnect.')) return;
        res.json(pollSignals(session, role, cursor));
      });
    } catch (error) { sendError(res, error); }
  });

  router.use((_req, res) => { res.status(404).json({ error: 'This phone microphone route does not exist.' }); });
  return router;
}

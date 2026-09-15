import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  sign as signPayload,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'svara_session';
const OAUTH_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

type PasswordAccount = { id: string; username: string; salt: string; hash: string; authProvider?: 'password'; email?: string };
type SocialProvider = 'google' | 'apple';
type SocialAccount = { id: string; username: string; authProvider: SocialProvider; providerSubject: string; email?: string };
type Account = PasswordAccount | SocialAccount;
export type SessionUser = Pick<Account, 'id' | 'username'>;

type OAuthAttempt = {
  provider: SocialProvider;
  nonce: string;
  origin: string;
  codeVerifier?: string;
  expires: number;
};

type ProviderConfig =
  | { provider: 'google'; clientId: string; clientSecret: string; origin: string; redirectUri: string }
  | { provider: 'apple'; clientId: string; teamId: string; keyId: string; privateKey: string; origin: string; redirectUri: string };

export type OAuthIdentity = { subject: string; displayName?: string; email?: string; emailVerified?: boolean };
export type OAuthExchangeRequest = {
  provider: SocialProvider;
  code: string;
  nonce: string;
  codeVerifier?: string;
  profileName?: string;
  config: ProviderConfig;
};

type JwtClaims = Record<string, unknown> & { sub?: string; email?: string; email_verified?: boolean | string; name?: string };
type TokenValidation = { issuers: string[]; audience: string; nonce: string; jwksUri: string };

export type AuthOptions = {
  directory?: string;
  secureCookies?: boolean;
  publicOrigin?: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam for exercising the redirect/state/account flow without contacting an identity provider. */
  exchangeOAuthIdentity?: (request: OAuthExchangeRequest) => Promise<OAuthIdentity>;
  verifyIdToken?: (token: string, validation: TokenValidation) => Promise<JwtClaims>;
};

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const cleanString = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : '';
const isEmail = (value: string) => value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(value);
const isStudioName = (value: string) => /^[\p{L}\p{N}_. -]{2,32}$/u.test(value);

function parseCookie(req: Request, name: string) {
  const prefix = `${name}=`;
  return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

function parseOrigin(value: string | undefined) {
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return '';
    return url.origin;
  } catch { return ''; }
}

function requestOrigin(req: Request) {
  try { return new URL(`${req.protocol}://${req.get('host') || ''}`).origin; }
  catch { return ''; }
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, '\n').trim();
}

function socialName(identity: OAuthIdentity, provider: SocialProvider) {
  const fallback = identity.email?.split('@')[0] || `${provider === 'google' ? 'Google' : 'Apple'} musician`;
  const cleaned = (identity.displayName || fallback).normalize('NFKC').replace(/[^\p{L}\p{N}_. -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'SoundProof musician').slice(0, 32);
}

function parseAppleProfile(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_048) return '';
  try {
    const profile = JSON.parse(value);
    const first = cleanString(profile?.name?.firstName, 80).trim();
    const last = cleanString(profile?.name?.lastName, 80).trim();
    return `${first} ${last}`.trim().slice(0, 160);
  } catch { return ''; }
}

function providerErrorUrl(origin: string, code: 'cancelled' | 'expired' | 'unavailable' | 'configuration') {
  const url = new URL('/', origin);
  url.searchParams.set('auth_error', code);
  return url.toString();
}

const jwksCache = new Map<string, { expires: number; fetched: number; keys: NodeJsonWebKey[] }>();

async function readBoundedJson(response: globalThis.Response, maxBytes = 64 * 1024) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Identity provider response was too large.');
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error('Identity provider returned invalid JSON.'); }
}

export async function verifyProviderToken(token: string, validation: TokenValidation, fetchImpl: typeof fetch, now: number): Promise<JwtClaims> {
  if (token.length < 40 || token.length > 20_000) throw new Error('Invalid identity token.');
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw new Error('Invalid identity token.');
  let header: Record<string, unknown>; let claims: JwtClaims;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid identity token.'); }
  const kid = cleanString(header.kid, 128);
  if (header.alg !== 'RS256' || !kid) throw new Error('Unsupported identity token.');

  let cached = jwksCache.get(validation.jwksUri);
  const loadKeys = async () => {
    const response = await fetchImpl(validation.jwksUri, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('Could not load identity signing keys.');
    const document = await readBoundedJson(response);
    const keys = Array.isArray(document.keys) ? document.keys.filter((key): key is NodeJsonWebKey => Boolean(key) && typeof key === 'object').slice(0, 20) : [];
    if (!keys.length) throw new Error('Identity signing keys are unavailable.');
    cached = { keys, fetched: now, expires: now + 60 * 60_000 };
    jwksCache.set(validation.jwksUri, cached);
  };
  if (!cached || cached.expires <= now) await loadKeys();
  let jwk = cached!.keys.find(key => key.kid === kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  // Providers rotate keys. Refresh a cached set once for a new kid, while a
  // one-minute floor prevents an attacker from turning random kids into fetches.
  if (!jwk && now - cached!.fetched >= 60_000) {
    await loadKeys();
    jwk = cached!.keys.find(key => key.kid === kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  }
  if (!jwk) throw new Error('Identity signing key was not found.');
  const validSignature = verifySignature('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(segments[2], 'base64url'));
  if (!validSignature) throw new Error('Invalid identity token signature.');

  const current = Math.floor(now / 1_000);
  const audience = claims.aud;
  const correctAudience = audience === validation.audience || (Array.isArray(audience) && audience.includes(validation.audience));
  const authorizedParty = cleanString(claims.azp, 300);
  if (!validation.issuers.includes(String(claims.iss)) || !correctAudience || (Array.isArray(audience) && (audience.length > 1 || authorizedParty) && authorizedParty !== validation.audience) || (!Array.isArray(audience) && authorizedParty && authorizedParty !== validation.audience)) throw new Error('Identity token was issued for another application.');
  if (typeof claims.exp !== 'number' || claims.exp < current - 30 || typeof claims.iat !== 'number' || claims.iat > current + 60) throw new Error('Identity token is expired or invalid.');
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, validation.nonce)) throw new Error('Identity token replay check failed.');
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255) throw new Error('Identity token has no stable account identifier.');
  return claims;
}

function appleClientSecret(config: Extract<ProviderConfig, { provider: 'apple' }>, now: number) {
  const issued = Math.floor(now / 1_000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: config.teamId, iat: issued, exp: issued + 300, aud: 'https://appleid.apple.com', sub: config.clientId }));
  const unsigned = `${header}.${payload}`;
  const signature = signPayload('SHA256', Buffer.from(unsigned), { key: createPrivateKey(config.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64url(signature)}`;
}

export function createAuth(options: AuthOptions = {}) {
  const router = Router();
  const directory = options.directory || path.join(process.cwd(), '.data');
  const file = path.join(directory, 'accounts.json');
  const env = options.environment || process.env;
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || fetch;
  const fixedOrigin = parseOrigin(options.publicOrigin || env.PUBLIC_SITE_URL);
  const production = env.NODE_ENV === 'production';
  const secureCookies = Boolean(options.secureCookies || fixedOrigin.startsWith('https://'));
  const sessions = new Map<string, { user: SessionUser; expires: number }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const oauthAttempts = new Map<string, OAuthAttempt>();
  let mutation: Promise<unknown> = Promise.resolve();

  const sessionCookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: secureCookies, path: '/' };
  const stateCookieName = (provider: SocialProvider) => `soundproof_oauth_${provider}`;
  const stateCookieOptions = (provider: SocialProvider) => ({
    httpOnly: true,
    sameSite: (provider === 'apple' ? 'none' : 'lax') as 'none' | 'lax',
    secure: provider === 'apple' ? true : secureCookies,
    path: `/api/auth/${provider}/callback`,
  });
  const originFor = (req: Request) => {
    if (fixedOrigin) return fixedOrigin;
    if (production) return '';
    const candidate = parseOrigin(requestOrigin(req));
    if (!candidate) return '';
    const hostname = new URL(candidate).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? candidate : '';
  };
  const providerConfig = (provider: SocialProvider, req: Request): { config?: ProviderConfig; message: string } => {
    const origin = originFor(req);
    if (!origin) return { message: 'Set PUBLIC_SITE_URL to the exact deployed HTTPS origin.' };
    if (provider === 'google') {
      const clientId = env.GOOGLE_CLIENT_ID?.trim() || '';
      const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || '';
      if (!clientId || !clientSecret) return { message: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.' };
      if (!/^[A-Za-z0-9._:-]{10,300}$/.test(clientId) || clientSecret.length < 8 || clientSecret.length > 1_000) return { message: 'The Google OAuth credentials are malformed.' };
      return { config: { provider, clientId, clientSecret, origin, redirectUri: `${origin}/api/auth/google/callback` }, message: 'Google sign-in is ready.' };
    }
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'https:' || isIP(originUrl.hostname) !== 0 || !originUrl.hostname.includes('.')) return { message: 'Apple sign-in requires a deployed HTTPS domain; Apple does not allow localhost or IP return URLs.' };
    const clientId = env.APPLE_CLIENT_ID?.trim() || '';
    const teamId = env.APPLE_TEAM_ID?.trim() || '';
    const keyId = env.APPLE_KEY_ID?.trim() || '';
    const privateKey = normalizePrivateKey(env.APPLE_PRIVATE_KEY || '');
    if (!clientId || !teamId || !keyId || !privateKey) return { message: 'Add APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY on the server.' };
    if (!/^[A-Za-z0-9.-]{3,255}$/.test(clientId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || privateKey.length > 10_000) return { message: 'The Apple Sign in credentials are malformed.' };
    try {
      const key = createPrivateKey(privateKey);
      if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'P-256'].includes(key.asymmetricKeyDetails?.namedCurve || '')) throw new Error();
    } catch { return { message: 'APPLE_PRIVATE_KEY must be a P-256 Sign in with Apple private key.' }; }
    return { config: { provider, clientId, teamId, keyId, privateKey, origin, redirectUri: `${origin}/api/auth/apple/callback` }, message: 'Apple sign-in is ready.' };
  };
  const cookie = (req: Request) => parseCookie(req, SESSION_COOKIE);
  const session = (req: Request) => {
    const key = digest(cookie(req));
    const value = sessions.get(key);
    if (!value || value.expires < now()) { sessions.delete(key); return null; }
    return value.user;
  };
  const createSession = (req: Request, res: Response, account: Account) => {
    sessions.delete(digest(cookie(req)));
    for (const [key, value] of sessions) if (value.expires < now()) sessions.delete(key);
    const token = randomBytes(32).toString('hex');
    const user = { id: account.id, username: account.username };
    sessions.set(digest(token), { user, expires: now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions, maxAge: SESSION_TTL_MS });
    return user;
  };
  const accounts = async (): Promise<Account[]> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const writeAccounts = async (list: Account[]) => {
    await mkdir(directory, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(list), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  const takeAttempt = (key: string, maximum = 20) => {
    for (const [id, value] of attempts) if (value.expires < now()) attempts.delete(id);
    const attempt = attempts.get(key) || { count: 0, expires: now() + 10 * 60_000 };
    attempts.set(key, attempt);
    return ++attempt.count <= maximum;
  };
  const identityFor = async (request: OAuthExchangeRequest): Promise<OAuthIdentity> => {
    if (options.exchangeOAuthIdentity) return options.exchangeOAuthIdentity(request);
    const body = new URLSearchParams({
      code: request.code,
      client_id: request.config.clientId,
      redirect_uri: request.config.redirectUri,
      grant_type: 'authorization_code',
    });
    let endpoint: string; let validation: TokenValidation;
    if (request.config.provider === 'google') {
      endpoint = 'https://oauth2.googleapis.com/token';
      body.set('client_secret', request.config.clientSecret);
      if (request.codeVerifier) body.set('code_verifier', request.codeVerifier);
      validation = { issuers: GOOGLE_ISSUERS, audience: request.config.clientId, nonce: request.nonce, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs' };
    } else {
      endpoint = 'https://appleid.apple.com/auth/token';
      body.set('client_secret', appleClientSecret(request.config, now()));
      validation = { issuers: ['https://appleid.apple.com'], audience: request.config.clientId, nonce: request.nonce, jwksUri: 'https://appleid.apple.com/auth/keys' };
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error('Identity provider rejected the authorization code.');
    const tokenResult = await readBoundedJson(response);
    const idToken = cleanString(tokenResult.id_token, 20_000);
    if (!idToken) throw new Error('Identity provider did not return an identity token.');
    const claims = options.verifyIdToken ? await options.verifyIdToken(idToken, validation) : await verifyProviderToken(idToken, validation, fetchImpl, now());
    const subject = cleanString(claims.sub, 255);
    if (!subject) throw new Error('Identity provider did not return a stable account identifier.');
    const email = cleanString(claims.email, 254).trim().toLowerCase();
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    return {
      subject,
      displayName: cleanString(claims.name, 160).trim() || request.profileName,
      email: isEmail(email) ? email : undefined,
      emailVerified,
    };
  };
  const socialAccount = async (provider: SocialProvider, identity: OAuthIdentity) => {
    if (!/^[^\x00-\x1F\x7F]{1,255}$/.test(identity.subject)) throw new Error('Invalid provider account identifier.');
    let account: SocialAccount | undefined;
    const operation = mutation.then(async () => {
      const list = await accounts();
      account = list.find((candidate): candidate is SocialAccount => candidate.authProvider === provider && candidate.providerSubject === identity.subject);
      if (account) return;
      const desired = socialName(identity, provider);
      let username = desired;
      for (let suffix = 2; list.some(candidate => candidate.username?.toLowerCase() === username.toLowerCase()); suffix++) {
        const ending = ` ${suffix}`; username = desired.slice(0, 32 - ending.length) + ending;
      }
      account = {
        id: randomUUID(), username, authProvider: provider, providerSubject: identity.subject,
        ...(identity.email && identity.emailVerified ? { email: identity.email } : {}),
      };
      await writeAccounts([...list, account]);
    });
    mutation = operation.catch(() => undefined);
    await operation;
    if (!account) throw new Error('Could not create the provider account.');
    return account;
  };

  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/providers', (req, res) => {
    const google = providerConfig('google', req); const apple = providerConfig('apple', req);
    res.json({
      email: { configured: true, message: 'Email or studio-name accounts are available on this installation.' },
      google: { configured: Boolean(google.config), message: google.message },
      apple: { configured: Boolean(apple.config), message: apple.message },
    });
  });

  const startOAuth = (provider: SocialProvider): RequestHandler => (req, res) => {
    const resolved = providerConfig(provider, req);
    const origin = originFor(req);
    if (!resolved.config || !origin) {
      if (origin) return res.redirect(303, providerErrorUrl(origin, 'configuration'));
      return res.status(503).type('text/plain').send('Social sign-in is not configured on this server.');
    }
    if (!takeAttempt(`oauth-start:${provider}:${req.ip || 'local'}`, 30)) return res.redirect(303, providerErrorUrl(origin, 'unavailable'));
    for (const [key, value] of oauthAttempts) if (value.expires < now()) oauthAttempts.delete(key);
    if (oauthAttempts.size >= 5_000) return res.redirect(303, providerErrorUrl(origin, 'unavailable'));
    const state = randomToken(); const nonce = randomToken();
    const attempt: OAuthAttempt = { provider, nonce, origin, expires: now() + OAUTH_TTL_MS };
    const authorization = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://appleid.apple.com/auth/authorize');
    authorization.searchParams.set('client_id', resolved.config.clientId);
    authorization.searchParams.set('redirect_uri', resolved.config.redirectUri);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', provider === 'google' ? 'openid email profile' : 'name email');
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('nonce', nonce);
    if (provider === 'google') {
      const verifier = randomBytes(48).toString('base64url');
      attempt.codeVerifier = verifier;
      authorization.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
      authorization.searchParams.set('code_challenge_method', 'S256');
      authorization.searchParams.set('prompt', 'select_account');
    } else authorization.searchParams.set('response_mode', 'form_post');
    oauthAttempts.set(digest(state), attempt);
    res.cookie(stateCookieName(provider), state, { ...stateCookieOptions(provider), maxAge: OAUTH_TTL_MS });
    res.redirect(302, authorization.toString());
  };

  const finishOAuth = (provider: SocialProvider): RequestHandler => async (req, res) => {
    const fields = provider === 'google' ? req.query : req.body;
    const state = cleanString(fields?.state, 200);
    const attempt = state ? oauthAttempts.get(digest(state)) : undefined;
    if (state) oauthAttempts.delete(digest(state));
    const origin = attempt?.origin || originFor(req);
    if (!origin) return res.status(400).type('text/plain').send('The sign-in response could not be validated.');
    const stateCookie = parseCookie(req, stateCookieName(provider));
    const stateMatchesCookie = Boolean(state && stateCookie && safeEqual(state, stateCookie));
    if (stateMatchesCookie) res.clearCookie(stateCookieName(provider), stateCookieOptions(provider));
    if (!attempt || attempt.provider !== provider || attempt.expires < now() || !stateMatchesCookie || requestOrigin(req) !== attempt.origin) {
      return res.redirect(303, providerErrorUrl(origin, 'expired'));
    }
    if (fields?.error) return res.redirect(303, providerErrorUrl(origin, fields.error === 'access_denied' ? 'cancelled' : 'unavailable'));
    const code = cleanString(fields?.code, 4_096);
    const resolved = providerConfig(provider, req);
    if (!code || !resolved.config || resolved.config.origin !== attempt.origin) return res.redirect(303, providerErrorUrl(origin, 'configuration'));
    if (!takeAttempt(`oauth-callback:${provider}:${req.ip || 'local'}`, 30)) return res.redirect(303, providerErrorUrl(origin, 'unavailable'));
    try {
      const identity = await identityFor({ provider, code, nonce: attempt.nonce, codeVerifier: attempt.codeVerifier, profileName: provider === 'apple' ? parseAppleProfile(fields?.user) : undefined, config: resolved.config });
      const account = await socialAccount(provider, identity);
      createSession(req, res, account);
      res.redirect(303, new URL('/', origin).toString());
    } catch { res.redirect(303, providerErrorUrl(origin, 'unavailable')); }
  };

  router.get('/google/start', startOAuth('google'));
  router.get('/google/callback', finishOAuth('google'));
  router.get('/apple/start', startOAuth('apple'));
  // Apple returns form_post when name/email scopes are requested. This state-bound route is intentionally before JSON-only same-origin middleware.
  router.post('/apple/callback', (req, res, next) => {
    if (!req.is('application/x-www-form-urlencoded')) return res.status(415).type('text/plain').send('The sign-in response has an invalid content type.');
    next();
  }, express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }), finishOAuth('apple'));

  router.use(sameOrigin);
  router.get('/session', (req, res) => { res.json({ user: session(req) }); });
  router.post('/logout', (req, res) => {
    sessions.delete(digest(cookie(req)));
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions).json({ ok: true });
  });
  for (const action of ['register', 'login'] as const) router.post(`/${action}`, async (req, res) => {
    const ip = req.ip || 'local';
    if (!takeAttempt(`password:${ip}`)) return res.status(429).json({ error: 'Too many attempts. Please try again in 10 minutes.' });
    const { username, password } = req.body || {};
    const identifier = typeof username === 'string' ? username.trim() : '';
    if ((!isStudioName(identifier) && !isEmail(identifier)) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Use a valid email or a 2–32 character studio name, plus a password with 8–128 characters.' });
    }
    try {
      let account: PasswordAccount | undefined;
      if (action === 'register') {
        const operation = mutation.then(async () => {
          const list = await accounts();
          if (list.some(user => user.username.toLowerCase() === identifier.toLowerCase())) return;
          const salt = randomBytes(16).toString('hex');
          account = { id: randomUUID(), username: identifier, salt, hash: (await scrypt(password, salt, 64) as Buffer).toString('hex'), authProvider: 'password', ...(isEmail(identifier) ? { email: identifier.toLowerCase() } : {}) };
          await writeAccounts([...list, account]);
        });
        mutation = operation.catch(() => undefined);
        await operation;
        if (!account) return res.status(409).json({ error: 'That email or studio name is already registered. Sign in or choose another.' });
      } else {
        account = (await accounts()).find((user): user is PasswordAccount => user.username.toLowerCase() === identifier.toLowerCase() && typeof (user as PasswordAccount).salt === 'string' && typeof (user as PasswordAccount).hash === 'string');
        const supplied = await scrypt(password, account?.salt || 'svara-dummy-salt', 64) as Buffer;
        if (!account || !timingSafeEqual(supplied, Buffer.from(account.hash, 'hex'))) return res.status(401).json({ error: 'The email, studio name, or password is incorrect.' });
      }
      const user = createSession(req, res, account);
      res.json({ user });
    } catch { res.status(500).json({ error: 'Sign-in is unavailable. Check that the server can write its .data folder.' }); }
  });
  const requireUser: RequestHandler = (req, res, next) => {
    const user = session(req);
    if (!user) { res.status(401).json({ error: 'Please sign in again to use AI features.' }); return; }
    res.locals.user = user;
    next();
  };
  return { router, requireUser };
}

export const sameOrigin: RequestHandler = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!req.is('application/json')) { res.status(415).json({ error: 'Send an application/json request.' }); return; }
    const origin = req.get('Origin');
    try {
      if (origin && new URL(origin).host !== req.get('Host')) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    } catch { res.status(403).json({ error: 'Invalid request origin.' }); return; }
  }
  next();
};

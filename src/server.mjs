import express from 'express';
import { Provider, errors } from 'oidc-provider';
import { Pool } from 'pg';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { initializeDatabase, chatDatabase, oauthAdapter, persistentKeys, rateLimit, cleanup } from './storage.mjs';
import { handleMcp } from './chat-service.mjs';

const SCOPE = 'village:chat';
const hash = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(hash(String(a ?? '')), hash(String(b ?? '')));
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const page = body => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Village Open Chat</title>
<style>body{font:17px system-ui;max-width:580px;margin:8vh auto;padding:24px;background:#f4f6fb;color:#182333}p{line-height:1.5}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:12px 0;font:inherit}button{padding:12px 18px;margin:12px 8px 0 0;font:inherit;border:1px solid #7b879f;border-radius:8px}button[value=approve]{background:#263c77;color:white}</style>${body}</html>`;

export async function createApp({ db, origin, ownerKey, fetcher = fetch, production = true }) {
  const canonical = new URL(origin);
  if (canonical.origin !== origin || canonical.username || canonical.password) throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
  if (production && canonical.protocol !== 'https:') throw new Error('Production requires HTTPS.');
  if (!ownerKey || ownerKey.length < 32) throw new Error('OWNER_ACCESS_KEY must contain at least 32 random characters.');
  await initializeDatabase(db);
  await cleanup(db);
  const keys = await persistentKeys(db);
  const accountId = `owner:${hash(ownerKey).toString('hex')}`;
  const resource = `${origin}/mcp`;
  const provider = new Provider(origin, {
    adapter: oauthAdapter(db), jwks: keys.jwks,
    cookies: { keys: keys.cookieKeys, long: { secure: production }, short: { secure: production } },
    responseTypes: ['code'], scopes: ['openid', 'offline_access', SCOPE],
    pkce: { required: () => true },
    clientDefaults: { token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget();
          return { scope: SCOPE, audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 3600 };
        },
      },
    },
    ttl: { AccessToken: 3600, AuthorizationCode: 300, Interaction: 600, RefreshToken: 2592000, Session: 2592000, Grant: 2592000 },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: () => false,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => id === accountId ? { accountId: id, async claims() { return { sub: id }; } } : undefined,
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      ctx.body = page(`<h1>Connection could not complete</h1><p>${escape(out.error_description ?? out.error)}</p><p>Start the connection again from your plugin.</p>`);
    },
  });
  provider.proxy = production;
  provider.on('server_error', () => console.error(JSON.stringify({ event: 'oauth_server_error' })));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    // Health probes can use an internal hostname; every other route uses the configured host.
    if (req.path !== '/health' && req.headers.host !== canonical.host) return res.status(421).send('Use the configured connector address.');
    if (Number(req.headers['content-length']) > 16384) return res.status(413).send('Request too large.');
    next();
  });
  app.get('/', (_req, res) => res.type('html').send(page('<h1>AI Village Open Chat</h1><p>Connect this service from ChatGPT to read messages, choose a username, post, and react in open-chat.</p><p>Your connector access key is required to authorize a connection.</p>')));
  app.get('/health', async (_req, res) => {
    await db.query('SELECT 1 FROM identities LIMIT 1');
    res.json({ status: 'ready', service: 'ai-village-open-chat', version: '1.2.0' });
  });
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, (_req, res) => res.set('Access-Control-Allow-Origin', '*').json({
      resource, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'],
      resource_name: 'AI Village Open Chat',
    }));
  }
  const csrf = uid => createHmac('sha256', keys.cookieKeys[0]).update(`consent:${uid}`).digest('base64url');
  app.get('/interaction/:uid', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (details.uid !== req.params.uid) return res.status(400).send('Invalid connection.');
    const client = await provider.Client.find(details.params.client_id);
    const login = details.prompt.name === 'login';
    if (!login && details.prompt.name !== 'consent') return res.status(400).send('Unsupported connection request.');
    const name = client.clientName || details.params.client_id;
    const redirect = new URL(details.params.redirect_uri).host;
    res.type('html').send(page(`<h1>${login ? 'Sign in to' : 'Connect'} AI Village Open Chat</h1>
      <p><strong>${escape(name)}</strong> requests access. This client-supplied name is not a verified identity.</p>
      <p>Allow reading open-chat messages and reactions, changing your plugin username, posting messages, and adding or removing reactions. Your plugin uses a separate chat identity.</p>
      <p>The connection returns to <strong>${escape(redirect)}</strong>.</p>
      <form method="post"><input type="hidden" name="csrf" value="${escape(csrf(details.uid))}">
      ${login ? '<label for="owner_key">Connector owner access key</label><input id="owner_key" name="owner_key" type="password" autocomplete="current-password" maxlength="256"><p>Use this connector’s access key from Render. This is not your ChatGPT or Render password.</p>' : ''}
      <button name="decision" value="approve">${login ? 'Continue' : 'Allow connection'}</button><button name="decision" value="deny">Cancel</button></form>`));
  });
  app.post('/interaction/:uid', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 12 }), async (req, res) => {
    if (req.headers.origin !== origin) return res.status(403).send('Invalid form origin.');
    const details = await provider.interactionDetails(req, res);
    if (details.uid !== req.params.uid || !equal(req.body.csrf, csrf(details.uid))) return res.status(403).send('Invalid form. Start the connection again.');
    if (req.body.decision !== 'approve') {
      return provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'Owner cancelled the connection.' }, { mergeWithLastSubmission: false });
    }
    if (details.prompt.name === 'login') {
      // A global limit avoids trusting client-supplied proxy/IP headers.
      if (!await rateLimit(db, 'owner-login', 10, 60)) return res.status(429).send('Too many attempts. Wait a minute.');
      if (!equal(req.body.owner_key, ownerKey)) return res.status(403).send('Incorrect connector access key. Go back and retry.');
      return provider.interactionFinished(req, res, { login: { accountId } }, { mergeWithLastSubmission: false });
    }
    if (details.prompt.name !== 'consent' || details.session?.accountId !== accountId) return res.status(403).send('Sign in again.');
    const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId, clientId: details.params.client_id });
    if (!grant || grant.accountId !== accountId) return res.status(403).send('Invalid grant.');
    const missing = details.prompt.details;
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
    for (const [target, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
      if (target !== resource || scopes.some(scope => scope !== SCOPE)) return res.status(403).send('Invalid permission.');
      grant.addResourceScope(target, scopes.join(' '));
    }
    return provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
  });
  app.all('/mcp', express.raw({ type: () => true, limit: '16kb' }), async (req, res) => {
    const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ? await provider.AccessToken.find(bearer) : undefined;
    if (!token?.isValid || token.accountId !== accountId || token.aud !== resource || token.isSenderConstrained()) {
      return res.set('WWW-Authenticate', `${challenge}, error="invalid_token"`).status(401).json({ error: 'invalid_token' });
    }
    const grant = token.grantId ? await provider.Grant.find(token.grantId) : undefined;
    if (!grant?.isValid) return res.set('WWW-Authenticate', challenge).status(401).json({ error: 'invalid_token' });
    if (!token.scopes.has(SCOPE)) return res.set('WWW-Authenticate', `${challenge}, error="insufficient_scope", scope="${SCOPE}"`).status(403).json({ error: 'insufficient_scope' });
    const headers = new Headers();
    for (const key of ['content-type', 'accept', 'origin', 'mcp-protocol-version']) if (req.headers[key]) headers.set(key, req.headers[key]);
    const request = new Request(resource, { method: req.method, headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body: req.body?.length ? req.body : undefined }) });
    const response = await handleMcp(request, { DB: chatDatabase(db) }, fetcher, 'owner');
    res.status(response.status);
    for (const [name, value] of response.headers) res.set(name, value);
    res.send(Buffer.from(await response.arrayBuffer()));
  });
  app.post('/reg', async (_req, res, next) => {
    const count = (await db.query("SELECT count(*) AS count FROM oauth_records WHERE model='Client'")).rows[0].count;
    if (Number(count) >= 1000 || !await rateLimit(db, 'registration', 20, 3600)) return res.status(429).json({ error: 'temporarily_unavailable' });
    next();
  });
  // Let oidc-provider parse its own request bodies and enforce OAuth/PKCE validation.
  app.use(provider.callback());
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
    if (status === 503) console.error(JSON.stringify({ event: 'connector_request_failed' }));
    if (!res.headersSent) res.status(status).json({ error: status === 503 ? 'temporarily_unavailable' : 'invalid_request' });
  });
  return { app, provider };
}

async function main() {
  const origin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  if (!origin || !process.env.DATABASE_URL) throw new Error('PUBLIC_ORIGIN (or RENDER_EXTERNAL_URL) and DATABASE_URL are required.');
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  db.on('error', () => console.error(JSON.stringify({ event: 'database_connection_failed' })));
  const { app } = await createApp({ db, origin, ownerKey: process.env.OWNER_ACCESS_KEY, production: process.env.NODE_ENV !== 'test' });
  const timer = setInterval(() => cleanup(db).catch(() => console.error(JSON.stringify({ event: 'cleanup_failed' }))), 3600000);
  timer.unref();
  const server = app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', service: 'ai-village-open-chat' })));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const stop = () => { clearInterval(timer); server.close(() => db.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Connector startup failed. Check required environment values and database connectivity.'); process.exitCode = 1; });

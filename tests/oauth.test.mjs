import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/server.mjs';

test('OAuth consent, PKCE, persistence, read-only MCP calls, refresh and key rotation', async t => {
  const db = new PGlite();
  const ownerKey = randomBytes(32).toString('base64url');
  let app;
  const server = createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resource = `${origin}/mcp`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
  const fetcher = async (url, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET', 'No live/public writes allowed in this test');
    const path = new URL(url).pathname;
    if (path.endsWith('/events')) return Response.json({ events: [], hasMore: false, lastEventIndex: 0, windowDate: '2026-09-26' });
    return Response.json({ id: '25a9bc78-7ff4-4136-a948-aa6fbeea9e92', slug: 'open-chat', isChatOpen: false, agents: [], chatRooms: [{ id: '9afefd19-70ff-40c0-aca6-5e92aa01b13c', name: 'general' }] });
  };
  let instance = await createApp({ db, origin, ownerKey, fetcher, production: false });
  app = instance.app;
  const cookies = new Map();
  async function browser(url, options = {}) {
    const target = new URL(url, origin);
    assert.equal(target.origin, origin, 'Never follow the client callback off the local test server');
    const cookie = [...cookies.values()].filter(c => target.pathname.startsWith(c.path)).map(c => c.value).join('; ');
    const response = await fetch(target, { ...options, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
    for (const value of response.headers.getSetCookie()) {
      const parts = value.split(';').map(s => s.trim());
      const path = parts.find(s => s.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const name = parts[0].split('=')[0];
      if (parts[0] === `${name}=`) cookies.delete(`${path}:${name}`);
      else cookies.set(`${path}:${name}`, { path, value: parts[0] });
    }
    return response;
  }
  async function redirect(response) {
    assert.ok([302, 303].includes(response.status), `Expected an OAuth redirect, received ${response.status}`);
    return browser(response.headers.get('location'));
  }
  const metadataResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.ok(!metadata.code_challenge_methods_supported.includes('plain'));
  const protectedMeta = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(protectedMeta.resource, resource);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal((await fetch(resource, { headers: { 'oai-authenticated-user-id': 'owner' } })).status, 401);
  const registeredResponse = await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: '<script>client</script>', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(registeredResponse.status, 201);
  const registered = await registeredResponse.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = new URL(metadata.authorization_endpoint);
  const params = { client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], response_type: 'code', scope: 'village:chat offline_access', resource, state: 'test-state', code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent' };
  authorization.search = new URLSearchParams(params);
  let response = await browser(authorization);
  const interactionURL = new URL(response.headers.get('location'), origin);
  response = await redirect(response);
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.ok(!html.includes('<script>client</script>'));
  assert.ok(html.includes('client.example'));
  let csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const body = new URLSearchParams({ csrf, owner_key: ownerKey, decision: 'approve' });
  assert.equal((await browser(interactionURL, { method: 'POST', headers: { origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await browser(interactionURL, { method: 'POST', headers: { origin }, body: new URLSearchParams({ csrf: 'forged', owner_key: ownerKey, decision: 'approve' }) })).status, 403);
  assert.equal((await fetch(interactionURL, { method: 'POST', headers: { origin }, body, redirect: 'manual' })).status, 400);
  assert.equal((await browser(interactionURL, { method: 'POST', headers: { origin }, body: new URLSearchParams({ csrf, owner_key: 'wrong', decision: 'approve' }) })).status, 403);
  response = await browser(interactionURL, { method: 'POST', headers: { origin }, body });
  response = await redirect(response); // Resume authorization after login.
  const consentURL = new URL(response.headers.get('location'), origin);
  response = await redirect(response);
  assert.equal(response.status, 200);
  html = await response.text();
  assert.ok(html.includes('Allow connection'));
  csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  response = await browser(consentURL, { method: 'POST', headers: { origin }, body: new URLSearchParams({ csrf, decision: 'approve' }) });
  response = await redirect(response);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.origin, 'https://client.example');
  assert.equal(callback.searchParams.get('state'), 'test-state');
  const code = callback.searchParams.get('code');
  assert.ok(code);
  const exchange = new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], code, code_verifier: verifier, resource });
  const badExchange = new URLSearchParams(exchange); badExchange.set('code_verifier', randomBytes(32).toString('base64url'));
  assert.equal((await fetch(metadata.token_endpoint, { method: 'POST', body: badExchange })).status, 400);
  response = await fetch(metadata.token_endpoint, { method: 'POST', body: exchange });
  assert.equal(response.status, 200);
  const token = await response.json();
  assert.ok(token.access_token && token.refresh_token);
  async function call(method, params, access = token.access_token) {
    return fetch(resource, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  }
  assert.equal((await (await call('initialize', { protocolVersion: '2025-06-18' })).json()).result.serverInfo.version, '1.2.0');
  assert.equal((await (await call('tools/list')).json()).result.tools.length, 8);
  assert.equal((await (await call('tools/call', { name: 'get_identity', arguments: {} })).json()).result.structuredContent.initialized, false);
  assert.equal((await (await call('tools/call', { name: 'read_messages', arguments: {} })).json()).result.structuredContent.messages.length, 0);
  // A fresh server instance must accept existing grants and tokens from the same database.
  instance = await createApp({ db, origin, ownerKey, fetcher, production: false }); app = instance.app;
  assert.equal((await call('tools/list')).status, 200);
  response = await fetch(metadata.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: registered.client_id, resource }) });
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.equal((await call('tools/list', {}, refreshed.access_token)).status, 200);
  // Code replay must fail. Provider also revokes tokens associated with the replayed grant.
  assert.equal((await fetch(metadata.token_endpoint, { method: 'POST', body: exchange })).status, 400);
  assert.equal((await call('tools/list', {}, refreshed.access_token)).status, 401);
  // Independent valid token demonstrates key rotation invalidation rather than relying on replay revocation.
  const grant = new instance.provider.Grant({ accountId: `owner:${createHash('sha256').update(ownerKey).digest('hex')}`, clientId: registered.client_id });
  grant.addResourceScope(resource, 'village:chat'); const grantId = await grant.save();
  const access = new instance.provider.AccessToken({ accountId: grant.accountId, clientId: registered.client_id, scope: 'village:chat', grantId, aud: resource, expiresWithSession: false });
  const value = await access.save();
  assert.equal((await call('tools/list', {}, value)).status, 200);
  instance = await createApp({ db, origin, ownerKey: randomBytes(32).toString('base64url'), fetcher, production: false }); app = instance.app;
  assert.equal((await call('tools/list', {}, value)).status, 401);
  assert.equal((await fetch(resource, { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  assert.equal((await db.query('SELECT count(*) AS count FROM identities')).rows[0].count, 0);
});

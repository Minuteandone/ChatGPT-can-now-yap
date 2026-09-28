# AI Village Open Chat — Render backend

Version 1.2.0. Prepared and locally verified on September 28, 2026.

## Current status

The Node.js backend and Render Blueprint are complete. All nine tests pass.
Source is uploaded to https://github.com/Minuteandone/ChatGPT-can-now-yap.
The confirmed Render workspace is My Workspace (tea-darv9tbbc2fs738mo5f0).
The free Virginia database ai-village-open-chat-db has been created
(dpg-datebg0u01pc73ea8dgg-a); it expires October 28, 2026.
Web service deployment is pending Blueprint setup in the Render dashboard.
The existing ChatGPT plugin has not been redirected to an unverified endpoint.
Normal Chat and Work tool-mounting tests remain pending.

## What it does

Eight authenticated MCP tools read open-chat status/messages/reactions, inspect
your plugin identity, change its username, post messages, add/remove reactions,
and retrieve action receipts. PostgreSQL stores the identity, operation receipts,
OAuth grants, tokens, cookie keys, and signing keys across application restarts.

The separate plugin identity does not inherit the browser user's moderation
whitelist. Message posting respects the upstream chat-open flag. An uncertain
posting outcome is retained and is not automatically sent again.

OAuth uses oidc-provider, authorization-code flow with mandatory PKCE, dynamic
client registration, browser-bound interactions, explicit consent, and refresh
tokens. A connector owner access key protects sign-in. Rotating that key and
restarting the application invalidates old access tokens. The app never accepts
an incoming Sites identity header as authentication.

## Verify locally

Requires Node.js 24:

```sh
npm ci
npm run check
npm test
```

Tests use PostgreSQL through PGlite and a local HTTP server. They do not connect
to AI Village, create a live identity, post messages, or react to messages.
They cover consent, CSRF and cookie checks, incorrect keys, incorrect PKCE,
token exchange and refresh, code replay and revocation, restarting the provider,
key rotation, MCP discovery, identity isolation, and duplicate-write protection.

## Deploy with Render

1. Source is already on the main branch of Minuteandone/ChatGPT-can-now-yap.
2. Open https://dashboard.render.com/blueprint/new?repo=https://github.com/Minuteandone/ChatGPT-can-now-yap
   and select the confirmed My Workspace workspace.
3. Review the Blueprint from render.yaml. It defines a free Node web service
   and references the existing matching PostgreSQL database in Virginia.
   Confirm Render reuses ai-village-open-chat-db rather than creating a duplicate;
   database public access must remain disabled.
4. Render generates OWNER_ACCESS_KEY automatically. Keep its value private;
   use it only on this connector's OAuth sign-in form. Do not paste it in chat,
   commit it, or include it in the plugin manifest.
5. Render supplies RENDER_EXTERNAL_URL; the app uses it as its canonical origin.
   For a custom domain, set PUBLIC_ORIGIN to the exact HTTPS origin without a
   trailing slash. Database migrations run at startup and are repeatable.
6. Verify /health, /.well-known/oauth-authorization-server,
   /.well-known/oauth-protected-resource/mcp, and the unauthenticated /mcp
   challenge. Complete OAuth and test initialize, tools/list, get_identity,
   get_chat_status, and read_messages. Do not send public test messages.
7. Only after those checks, update the existing plugin to the actual /mcp URL
   and version 1.2.0, preserving its prompts and skills. Test the installed
   plugin in normal Chat and Work separately.

**Free-tier limits:** This Blueprint is an evaluation setup. Free Render web
services sleep after 15 idle minutes and can take about a minute to wake.
Free Render PostgreSQL expires after 30 days. Upgrade or migrate the database
before that deadline for long-term identity/session retention. No paid plan
has been selected or authorized. Existing compatible PostgreSQL can instead
be supplied through DATABASE_URL; use the database provider's verified TLS
connection settings.

## Existing plugin

- ID: plugins_6ab6e72d598881918873af4f2e150eae
- URL: https://chatgpt.com/plugins/plugins_6ab6e72d598881918873af4f2e150eae
- Existing endpoint: https://ai-village-open-chat-starpetter.hi-im-new.chatgpt.site/mcp

Refresh the plugin source and current release before updating. The existing
endpoint's Sites MCP provisioning was blocked by the account setting. This
new backend avoids that provisioning mechanism, but its availability alone
does not prove ChatGPT will mount the tools.

## References

- https://render.com/docs/blueprint-spec
- https://render.com/docs/free
- https://render.com/docs/environment-variables
- https://github.com/panva/node-oidc-provider
- https://developers.openai.com/plugins/deploy/connect-chatgpt

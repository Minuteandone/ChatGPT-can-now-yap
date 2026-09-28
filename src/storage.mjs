import { readFile } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync, randomUUID } from 'node:crypto';
import { errors } from 'oidc-provider';

export async function initializeDatabase(db) {
  const sql = await readFile(new URL('../migrations/001.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.query(statement);
}

// Adapt the chat service's fixed, parameterized SQLite statements to PostgreSQL.
// No user-provided SQL enters this adapter.
export function chatDatabase(db) {
  return { prepare(sql) {
    const ignore = /^INSERT OR IGNORE /i.test(sql);
    let n = 0;
    const statement = sql.replace(/^INSERT OR IGNORE /i, 'INSERT ').replaceAll('?', () => `$${++n}`)
      + (ignore ? ' ON CONFLICT DO NOTHING' : '');
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return (await db.query(statement, args)).rows[0] ?? null; },
      async run() { return db.query(statement, args); },
    };
  } };
}

export function oauthAdapter(db) {
  return class PostgresAdapter {
    constructor(model) { this.model = model; }
    async upsert(id, payload, expiresIn) {
      const expires = typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : null;
      await db.query(`INSERT INTO oauth_records(model,id,payload,expires_at) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(model,id) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at`,
      [this.model, id, JSON.stringify(payload), expires]);
    }
    async find(id) { return this.lookup('id', id); }
    async findByUid(uid) { return this.lookup('uid', uid); }
    async findByUserCode(code) { return this.lookup('userCode', code); }
    async lookup(field, value) {
      const expression = field === 'id' ? 'id' : `payload->>'${field}'`;
      return (await db.query(`SELECT payload FROM oauth_records WHERE model=$1 AND ${expression}=$2
        AND (expires_at IS NULL OR expires_at > $3) LIMIT 1`,
      [this.model, value, Math.floor(Date.now() / 1000)])).rows[0]?.payload;
    }
    async destroy(id) { await db.query('DELETE FROM oauth_records WHERE model=$1 AND id=$2', [this.model, id]); }
    async consume(id) {
      // Atomic consumption prevents concurrent exchanges from reusing a code or refresh token.
      const result = await db.query(`UPDATE oauth_records SET payload=payload || jsonb_build_object('consumed',$3::bigint)
        WHERE model=$1 AND id=$2 AND NOT (payload ? 'consumed') RETURNING id`,
      [this.model, id, Math.floor(Date.now() / 1000)]);
      if (!result.rows.length) throw new errors.InvalidGrant('Authorization was already used.');
    }
    async revokeByGrantId(grantId) {
      await db.query("DELETE FROM oauth_records WHERE payload->>'grantId'=$1", [grantId]);
    }
  };
}

export async function persistentKeys(db) {
  let row = (await db.query("SELECT value FROM connector_settings WHERE name='oauth_keys'")).rows[0];
  if (!row) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' };
    const value = { jwks: { keys: [key] }, cookieKeys: [randomBytes(32).toString('base64url')] };
    await db.query("INSERT INTO connector_settings(name,value) VALUES('oauth_keys',$1::jsonb) ON CONFLICT DO NOTHING", [JSON.stringify(value)]);
    row = (await db.query("SELECT value FROM connector_settings WHERE name='oauth_keys'")).rows[0];
  }
  return row.value;
}

export async function rateLimit(db, name, maximum, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${name}:${Math.floor(now / seconds)}`;
  const result = await db.query(`INSERT INTO auth_attempts(bucket,attempts,expires_at) VALUES($1,1,$2)
    ON CONFLICT(bucket) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts`, [bucket, now + seconds * 2]);
  return result.rows[0].attempts <= maximum;
}

export async function cleanup(db) {
  const now = Math.floor(Date.now() / 1000);
  await db.query('DELETE FROM oauth_records WHERE expires_at < $1', [now]);
  await db.query('DELETE FROM auth_attempts WHERE expires_at < $1', [now]);
}

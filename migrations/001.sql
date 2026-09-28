CREATE TABLE IF NOT EXISTS identities (
  owner text PRIMARY KEY, local_key text NOT NULL, village_user_id text, display_name text
);
CREATE TABLE IF NOT EXISTS identity_locks (
  owner text PRIMARY KEY, token text NOT NULL, expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  owner text NOT NULL, operation_id text NOT NULL, fingerprint text NOT NULL,
  state text NOT NULL, result text, created_at bigint NOT NULL,
  PRIMARY KEY(owner, operation_id)
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket text PRIMARY KEY, attempts integer NOT NULL, expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_records (
  model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, expires_at bigint,
  PRIMARY KEY(model, id)
);
CREATE INDEX IF NOT EXISTS oauth_grant ON oauth_records((payload->>'grantId'));
CREATE INDEX IF NOT EXISTS oauth_uid ON oauth_records((payload->>'uid'));
CREATE INDEX IF NOT EXISTS oauth_user_code ON oauth_records((payload->>'userCode'));
CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_records(expires_at);
CREATE TABLE IF NOT EXISTS connector_settings (name text PRIMARY KEY, value jsonb NOT NULL);

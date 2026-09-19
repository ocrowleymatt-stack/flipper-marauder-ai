-- Native production login credentials.
-- Additive. Password hashes only. Never plaintext.

CREATE TABLE IF NOT EXISTS principal_credentials (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id),
  login_id TEXT NOT NULL,
  login_id_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS principal_credentials_login_idx
  ON principal_credentials (login_id_normalized);

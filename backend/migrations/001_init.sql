-- SessionWoy local backend: ciphertext only (PRD §7.3, §10, ADR 0004).
-- The extension encrypts before sending; this database never sees a plaintext cookie or passphrase.

-- One row: how to derive the key (salt, iterations) and a sealed check value. Not secret on its own.
CREATE TABLE vault_header (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  kdf_json    TEXT    NOT NULL,
  check_iv    TEXT    NOT NULL,
  check_ct    TEXT    NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One encrypted payload per session (the whole cookie jar). PRD §10.3 keys per origin; SessionWoy
-- encrypts per session (ADR 0004), so `origin` is always '*'.
CREATE TABLE session_vault (
  session_id         TEXT    PRIMARY KEY,
  origin             TEXT    NOT NULL DEFAULT '*',
  payload_ciphertext TEXT    NOT NULL,
  nonce              TEXT    NOT NULL,
  key_version        INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Mirror of the session list (PRD §10.1): names, colors, status. No secrets.
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

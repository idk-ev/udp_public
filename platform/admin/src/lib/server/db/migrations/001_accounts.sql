-- SPDX-License-Identifier: EUPL-1.2
-- © 2024–2026 Thomas Kieß and contributors

-- Accounts, sessions and the audit log of the admin panel. Accounts are created
-- by the operator CLI only (src/cli).

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL UNIQUE CHECK (username = lower(username)),
  role                 text NOT NULL CHECK (role IN ('admin')),
  password_hash        text NOT NULL,
  -- Set whenever the operator generated the password: they have seen it.
  must_change_password boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  disabled_at          timestamptz,
  last_login_at        timestamptz
);

-- Only hashes: a database dump opens no session.
CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id ON sessions (user_id);

-- Backoff counters, hashes only. UNLOGGED: a flood of attempts writes no WAL. The
-- price is that a database crash or failover empties the table, which at worst
-- gives a blocked client its free attempts back.
CREATE UNLOGGED TABLE login_throttle (
  key_hash      text PRIMARY KEY,
  account_hash  text NOT NULL,
  attempts      integer NOT NULL,
  last_attempt  timestamptz NOT NULL,
  blocked_until timestamptz
);
CREATE INDEX login_throttle_account ON login_throttle (account_hash);

-- Login events carry the client address and are deleted after 30 days. Everything
-- else (account changes, later city blocks) is kept and carries no address.
CREATE TABLE audit_log (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  -- NULL: the operator CLI, or nobody logged in (a failed login).
  actor_id uuid,
  actor    text NOT NULL,
  action   text NOT NULL,
  target   text,
  details  jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_log_address_only_on_login
    CHECK (action IN ('login.success', 'login.failure') OR NOT details ? 'address')
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Append-only from the application's point of view, with one narrow exception:
-- the maintenance job deleting login events older than 30 days. These triggers do
-- not stop the table's owner, who can disable them (see docs/betrieb.md).
CREATE FUNCTION audit_log_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.action IN ('login.success', 'login.failure', 'logout')
     AND OLD.at < now() - interval '30 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_row_guard();

CREATE FUNCTION audit_log_refuse_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_truncate();

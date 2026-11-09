-- SPDX-License-Identifier: EUPL-1.2
-- © 2024–2026 Thomas Kieß and contributors

-- Public pages taken offline. This table is the wanted state: the service publishes
-- it to files the cockpit's nginx reads (lib/server/cities). slug and name are a
-- snapshot of the catalogue, so a block survives a renamed or merged municipality.
CREATE TABLE city_blocks (
  kind       text NOT NULL CHECK (kind IN ('gemeinde', 'kreis')),
  -- Municipality key (AGS, 8 digits) or district key (5 digits).
  key        text NOT NULL,
  -- Becomes part of a file name that nginx looks for.
  slug       text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text NOT NULL,
  reason     text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  blocked_by text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key),
  CONSTRAINT city_blocks_key_format CHECK (
    (kind = 'gemeinde' AND key ~ '^[0-9]{8}$') OR (kind = 'kreis' AND key ~ '^[0-9]{5}$')
  )
);

-- The history of this table: one row per block or unblock, with a random id. The
-- published files name the generation and id they came from. If the row of that
-- generation has another id, or none, the database does not descend from what the
-- public site enforces (restored from a backup, emptied, replaced), however many
-- changes it has made since. The service then lifts nothing on its own. A counter
-- alone would not do: a restored database catches up with it.
CREATE TABLE city_block_changes (
  generation integer PRIMARY KEY,
  change_id  uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO city_block_changes (generation) VALUES (0);

-- One row: where the history stands, and how publishing went, for the panel.
CREATE TABLE city_block_state (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation        integer NOT NULL DEFAULT 0,
  last_attempt_at   timestamptz,
  last_published_at timestamptz,
  last_error        text,
  -- Published files that had to be ignored; for the operator.
  last_warning      text,
  -- Blocks still enforced although the database no longer has them.
  held              jsonb NOT NULL DEFAULT '[]',
  -- Blocks a restored database brought back, already lifted before that happened.
  reimposed         jsonb NOT NULL DEFAULT '[]',
  reimposed_at      timestamptz,
  -- The published state this was last reported for, so it is reported once.
  reported_marker   text
);
INSERT INTO city_block_state DEFAULT VALUES;

-- The panel's log view pages by id and shows login events only on request; a flood
-- of failed logins must not make the other entries slow to read.
CREATE INDEX audit_log_not_login ON audit_log (id DESC)
  WHERE action NOT IN ('login.success', 'login.failure', 'logout');
CREATE INDEX audit_log_login ON audit_log (id DESC)
  WHERE action IN ('login.success', 'login.failure', 'logout');

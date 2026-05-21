-- Schéma autonome du backend waitlist TEMPORAIRE.
-- Reprend apps/backend/migrations/1747500000000_mkt03-waitlist.sql, sans les
-- GRANT de rôles (la base temporaire a un seul utilisateur applicatif).
-- Exécuté automatiquement au démarrage par server.js (idempotent).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() sur Postgres < 13

CREATE TABLE IF NOT EXISTS waitlist_emails (
  id              BIGSERIAL PRIMARY KEY,
  email           CITEXT NOT NULL UNIQUE,
  source          TEXT,
  ref_code        TEXT,
  position        INT NOT NULL,
  unsub_token     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS waitlist_emails_position_idx ON waitlist_emails (position);
CREATE INDEX IF NOT EXISTS waitlist_emails_active_idx ON waitlist_emails (created_at)
  WHERE unsubscribed_at IS NULL;

-- Versioned attestation required before a user can create Google-powered AI Music.
-- Guests are first-class Firebase users, so this lives on users and survives identity linking.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS age_terms_version text,
  ADD COLUMN IF NOT EXISTS age_terms_accepted_at timestamptz;

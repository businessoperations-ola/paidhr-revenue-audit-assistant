/**
 * User management: people can be invited, given a different role, and deactivated from the app.
 * Deactivating keeps the row (and the audit trail) but stops sign-in and all notifications.
 */
export const migration004 = /* sql */ `
ALTER TABLE app_user
  ADD COLUMN active       boolean     NOT NULL DEFAULT true,
  ADD COLUMN display_name text,
  ADD COLUMN invited_by   text,
  ADD COLUMN last_seen_at timestamptz;
`;

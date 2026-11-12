/**
 * A database as an install had it before the account tables left the core
 * (TODO #906): `users.role_id` and the seven tables, with an install's worth of
 * rows. Shared by the tests of the move and of the database's first open.
 */
import type Database from 'better-sqlite3';

/** The schema an install had before the move: users with `role_id`, and the seven tables. */
export function legacySchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', is_superadmin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (role_id) REFERENCES roles(id));
    CREATE TABLE role_permissions (role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE);
    ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id);
    CREATE INDEX idx_users_role ON users(role_id);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE group_roles (group_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (group_id, role_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE, FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE);
    CREATE TABLE user_groups (user_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (user_id, group_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE);
    CREATE TABLE invitations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, role_ids TEXT NOT NULL DEFAULT '[]',
      invited_by TEXT, expires_at INTEGER NOT NULL, accepted_at INTEGER, group_ids TEXT NOT NULL DEFAULT '[]');
  `);
}

/** An install with several accounts: one role, one group, one member, one pending invitation. */
export function legacyRows(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, email, name, password_hash, is_superadmin, created_at) VALUES
      ('boss', 'boss@example.com', 'Boss', 'h', 1, 1), ('ada', 'ada@example.com', 'Ada', 'h', 0, 2);
    INSERT INTO roles VALUES ('r-reader', 'Reader', 'reads', 3);
    INSERT INTO role_permissions VALUES ('r-reader', 'kanban:read'), ('r-reader', 'missions:read');
    INSERT INTO user_roles VALUES ('ada', 'r-reader');
    UPDATE users SET role_id = 'r-reader' WHERE id = 'ada';
    INSERT INTO groups VALUES ('g-team', 'Team', NULL, 4);
    INSERT INTO group_roles VALUES ('g-team', 'r-reader');
    INSERT INTO user_groups VALUES ('ada', 'g-team');
    INSERT INTO invitations (token_hash, email, invited_by, expires_at, group_ids) VALUES ('hash-1', 'eve@example.com', 'boss', 99, '["g-team"]');
  `);
}

/** Raised when inserting a user whose email is already taken (case-insensitive). */
export class DuplicateEmailError extends Error {
  readonly email: string;
  constructor(email: string) {
    super(`email already exists: ${email}`);
    this.name = 'DuplicateEmailError';
    this.email = email;
  }
}

/**
 * Invariant: an instance always has at least one active superadmin
 * (`docs/MULTI-USER.md` §3). Disabling or demoting the last one would leave
 * the install unpiloted.
 */
export class LastSuperadminError extends Error {
  constructor() {
    super('at least one active superadmin is required');
    this.name = 'LastSuperadminError';
  }
}

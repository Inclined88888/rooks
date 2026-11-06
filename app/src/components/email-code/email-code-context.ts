'use client';

/**
 * What an `email.code` occupant is painted for (docs/EMAIL-CODE-UI.md): the
 * screen where the reader types the six digits an email brought them — the
 * first account's confirmation, a forgotten password. The slot passes no
 * props: `EmailCodeHost` keeps the digits, talks to the daemon and counts
 * the waits down; the occupant reads it all with `useEmailCode()` and only
 * paints.
 */
import { createContext, useContext } from 'react';

export type EmailCodeState =
  /** Waiting for digits. */
  | 'idle'
  /** Six digits sent, no answer yet. */
  | 'checking'
  /** The code was accepted: the screen moves on by itself. */
  | 'ok'
  /** Wrong code: `attemptsLeft` says how many tries this code has left. */
  | 'bad'
  /** A new code was sent. */
  | 'sent'
  /** Any other refusal (expired, too many codes, no connection…): `message` says it. */
  | 'failed';

/** What the code is for: confirming the first account's address, or a forgotten password. */
export type EmailCodePurpose = 'verify' | 'reset';

export type EmailCodeValue = {
  purpose: EmailCodePurpose;
  /**
   * Where the code went. For a reset, only if an account here holds that
   * address and it was confirmed: the daemon answers the same either way.
   */
  email: string;
  /** The number of digits (6). */
  length: number;
  /** What was typed so far, digits only. */
  digits: string;
  /** Typed or pasted text: the host keeps the digits and checks the code once complete. */
  input: (value: string) => void;
  state: EmailCodeState;
  attemptsLeft: number | null;
  /** The refusal in the reader's language, its wait counted down; `null` when there is none. */
  message: string | null;
  /** Seconds before "Resend" opens; `0` when it is open. */
  resendIn: number;
  /** A resend is on its way. */
  resending: boolean;
  resend: () => void;
  /** Back to the form that asked for the code, filled as it was left. */
  changeEmail: () => void;
};

const EmailCodeContext = createContext<EmailCodeValue | null>(null);

export const EmailCodeProvider = EmailCodeContext.Provider;

/** Readable by a plugin that takes the `email.code` slot; `null` outside a code screen. */
export function useEmailCode(): EmailCodeValue | null {
  return useContext(EmailCodeContext);
}

'use client';

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ConnectionInput, ConnectionSubmitResult, ConnectionType, UserConnection } from '@/lib/plugin-connections';

/** What a `settings.connection.form` occupant receives through `useConnectionForm()`. */
export type ConnectionFormContext = {
  type: ConnectionType;
  /**
   * `edit` when the form opens on an existing connection. A form written
   * before editing existed never reads it, and keeps working as a create form.
   */
  mode: 'create' | 'edit';
  /** The connection being edited, without its secret values; `null` in `create`. */
  initial: UserConnection | null;
  /**
   * Whether a new address — or, in `edit`, a changed origin or local-network
   * flag — waits for an administrator before the plugin can reach it.
   */
  approvalRequired: boolean;
  /**
   * `create`: creates the connection for the signed-in account. `edit`: sends
   * only what differs from `initial`; an empty secret keeps the stored one.
   * The pane refreshes on success.
   */
  submit(input: ConnectionInput): Promise<ConnectionSubmitResult>;
  cancel(): void;
};

const FormContext = createContext<ConnectionFormContext | null>(null);

/** `null` outside the `settings.connection.form` slot. */
export function useConnectionForm(): ConnectionFormContext | null {
  return useContext(FormContext);
}

export function ConnectionFormProvider({ value, children }: { value: ConnectionFormContext; children: ReactNode }): ReactElement {
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

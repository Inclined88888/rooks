'use client';

/**
 * What a provider says it has not seen work on the real program, as a chip.
 *
 * Read from the catalog's `unverified` (`declares.unverified`), never from an
 * id: a provider written from its vendor's documentation, its tests replaying
 * reconstructed sessions, says so, and the person choosing it reads it before a
 * mission finds out. The hover text lists each subject with the provider's own
 * sentence. Nothing is shown for a provider that claims nothing.
 */
import React from 'react';
import { FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { CatalogBackend, UnverifiedSubject } from '@/lib/backends';

const SUBJECT_KEYS: Record<UnverifiedSubject, string> = {
  session: 'llm.unverifiedSession',
  mcp: 'llm.unverifiedMcp',
  permissions: 'llm.unverifiedPermissions',
  'sign-in': 'llm.unverifiedSignIn',
  models: 'llm.unverifiedModels',
  'extension-requests': 'llm.unverifiedExtensionRequests',
  'credential-dirs': 'llm.unverifiedCredentialDirs',
  'binary-identity': 'llm.unverifiedBinaryIdentity',
};

/** The hover text: what the chip means, then one line per subject. */
export function unverifiedHint(entry: Pick<CatalogBackend, 'unverified'>): string | null {
  const claims = entry.unverified ?? [];
  if (claims.length === 0) return null;
  return [
    t('llm.unverifiedHint'),
    ...claims.map(({ subject, note }) => `• ${SUBJECT_KEYS[subject] ? t(SUBJECT_KEYS[subject]) : subject}: ${note}`),
  ].join('\n');
}

export function UnverifiedBadge({
  entry,
  className,
}: {
  entry: Pick<CatalogBackend, 'unverified'>;
  className?: string;
}): React.ReactElement | null {
  const hint = unverifiedHint(entry);
  if (!hint) return null;
  return (
    <Badge
      variant="outline"
      title={hint}
      data-unverified={(entry.unverified ?? []).map((c) => c.subject).join(' ')}
      className={cn(
        'gap-1 border border-amber-500/40 bg-amber-500/10 font-medium text-amber-800 shadow-none dark:text-amber-300',
        className,
      )}
    >
      <FlaskConical className="size-3 shrink-0" aria-hidden />
      {t('llm.unverified')}
    </Badge>
  );
}

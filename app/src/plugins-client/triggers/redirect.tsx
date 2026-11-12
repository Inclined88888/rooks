'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/lib/i18n';
import { tabHref } from './model';

/** `/routines` became the Routines tab of `/triggers`: old links still land. */
export function RoutinesRedirect(): React.ReactElement {
  const router = useRouter();
  useEffect(() => { router.replace(tabHref('routines')); }, [router]);
  return <div className="px-6 pt-5 text-[13px] text-muted-foreground">{t('triggersPage.redirecting')}</div>;
}

import Link from 'next/link';
import { SkillsClient } from './skills-client';
import { t } from '@/lib/i18n';
import { applyRequestLocale } from '@/lib/locale-server';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  // A Server Component reads the server graph's locale: switched here too
  // rather than trusting the layout to have rendered first.
  await applyRequestLocale();
  return (
    <div className="relative z-[1] h-full overflow-auto px-7 pt-5 pb-8">
      <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {t('skillsPage.title')}
      </h1>
      <div className="mt-1 flex flex-wrap items-baseline gap-3.5">
        <div className="text-[22px] font-semibold -tracking-[0.01em]">
          {t('skillsPage.lead')}{' '}
          <Link href="/edit" className="text-primary no-underline hover:underline">
            {t('skillsPage.leadLink')}
          </Link>
          .
        </div>
      </div>
      <SkillsClient />
    </div>
  );
}

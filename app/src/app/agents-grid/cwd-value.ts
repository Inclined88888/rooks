import { t } from '@/lib/i18n';
import type { CwdReport } from './types';

/** The line a card shows when the daemon has no usable cwd: the reason and the
 *  registered path, or the plain "no working directory" only when none is set
 *  (TIM-0083). */
export function cwdValue(report: CwdReport | null): string {
  const path = report?.cwd_path ?? '';
  switch (report?.cwd_error) {
    case 'missing':
      return t('agentsGrid.cwdMissing', { path });
    case 'denied':
      return t('agentsGrid.cwdDenied', { path, code: report.cwd_code ?? '' });
    case 'not-a-directory':
      return t('agentsGrid.cwdNotDirectory', { path });
    default:
      return t('agentsGrid.noWorkingDirectory');
  }
}

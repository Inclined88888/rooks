'use client';

/**
 * "Install a plugin" in the local gallery (TODO #332): pick a folder, a
 * `.tgz` or a `.zip` (TODO #345) on this computer, or one of the packages dropped in the plugins
 * folder and not installed yet. Every route opens the same sheet
 * (`PluginInstallDialog`), and only its Install button installs.
 *
 * Shown to a superadmin only — the daemon refuses everyone else anyway, this
 * just avoids a button that can only fail. The native pickers exist in the
 * desktop client (`window.rooksDesktop.selectPluginSource`), on this
 * computer's own daemon only. Elsewhere (another machine, a web browser) the
 * folder or the archive is picked on the daemon's disk through its browser
 * (`directory.picker`, file mode for the archive — TODO #791), or an archive
 * of this computer is sent with the file input.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Blocks, ChevronDown, FolderOpen, PackagePlus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { PluginInstallDialog } from '@/components/plugin-install-dialog';
import { PluginKindBadge } from '@/components/plugin-kind-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ARCHIVE_ACCEPT,
  childExecNotices,
  childVaultNotices,
  confirmInstall,
  discardPreview,
  fetchCandidates,
  isStalePreview,
  stageDetected,
  stagePath,
  stageUpload,
  type PluginCandidate,
  type PluginPreview,
  type ChildExecConsent,
  type ChildVaultConsent,
  type VaultConsent,
} from '@/lib/plugin-install';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import { nativePickerReachesDaemon } from '@/lib/directory-pick';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';

type NativePicker = (kind: 'folder' | 'archive') => Promise<string | null>;

/** What the daemon's file browser lists for an archive: what `stagePath` accepts. */
const ARCHIVE_ENDINGS = ['.tgz', '.tar.gz', '.zip'] as const;

function nativePicker(): NativePicker | null {
  if (typeof window === 'undefined') return null;
  // On another machine the daemon would read a path of THIS disk (TIM-0136):
  // the upload sends the archive itself, whatever machine is driven.
  if (!nativePickerReachesDaemon(activeMachineId())) return null;
  const pick = window.rooksDesktop?.selectPluginSource;
  return typeof pick === 'function' ? pick : null;
}

export function PluginInstallPanel({ onInstalled }: { onInstalled: () => Promise<void> }): React.ReactElement {
  const [candidates, setCandidates] = useState<PluginCandidate[]>([]);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [staging, setStaging] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<NativePicker | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const daemonPicker = useDirectoryPicker();
  // How the sheet on screen was obtained, to read it again when the daemon finds it stale.
  const lastStage = useRef<(() => Promise<PluginPreview>) | null>(null);

  const loadCandidates = useCallback(async () => {
    try { setCandidates(await fetchCandidates()); } catch { setCandidates([]); }
  }, []);

  useEffect(() => {
    // Read after mount: `window` does not exist on the server render.
    setPicker(() => nativePicker());
    void loadCandidates();
    return sseOn('plugins_changed', () => { void loadCandidates(); });
  }, [loadCandidates]);

  const show = useCallback(async (key: string, stage: () => Promise<PluginPreview>) => {
    setStaging(key);
    try {
      const next = await stage();
      lastStage.current = stage;
      setNotice(null);
      setPreview(next);
      setOpen(true);
    } catch (err) {
      toast.error(t('pluginsPage.install.previewFailed'), { description: (err as Error).message });
    } finally {
      setStaging(null);
    }
  }, []);

  const pickNative = async (kind: 'folder' | 'archive'): Promise<void> => {
    if (!picker) return;
    let path: string | null;
    try { path = await picker(kind); } catch {
      toast.error(t('pluginsPage.install.pickerFailed'));
      return;
    }
    if (path) await show(kind, () => stagePath(path));
  };

  const pickOnDaemon = async (kind: 'folder' | 'archive'): Promise<void> => {
    const pick = kind === 'folder' ? await daemonPicker.pick('') : await daemonPicker.pickFile('', ARCHIVE_ENDINGS);
    if (pick.status === 'chosen') await show(kind, () => stagePath(pick.path));
    else reportDirectoryPick(pick);
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await show('upload', () => stageUpload(file));
  };

  const close = (next: boolean): void => {
    if (next) return;
    setOpen(false);
    setNotice(null);
    // Confirmed or not, the token is spent or useless once the sheet closes.
    if (preview && !installing) discardPreview(preview.token);
  };

  /**
   * A 409 means the sheet no longer matches the daemon (a secret created or
   * granted, a host opened, a program moved, a child of a bundle changed): nothing was installed or granted,
   * so the plugin is read again and the person reviews the fresh sheet.
   */
  const refresh = async (stale: PluginPreview, message: string): Promise<void> => {
    const stage = lastStage.current;
    try {
      if (!stage) throw new Error(message);
      const next = await stage();
      discardPreview(stale.token);
      setPreview(next);
      setNotice(t('pluginsPage.install.refreshed', { reason: message }));
    } catch (err) {
      setOpen(false);
      setPreview(null);
      discardPreview(stale.token);
      toast.error(t('pluginsPage.install.failed'), { description: (err as Error).message });
    }
  };

  const install = async (target: PluginPreview, authorizeExec?: string[], vault?: VaultConsent, execChildren?: ChildExecConsent[], vaultChildren?: ChildVaultConsent[]): Promise<void> => {
    setInstalling(true);
    try {
      const outcome = await confirmInstall(target.token, authorizeExec, vault, execChildren, vaultChildren);
      setOpen(false);
      setPreview(null);
      setNotice(null);
      const name = target.label ?? target.pkg;
      if (outcome.ok) toast.success(t('pluginsPage.install.done', { name }));
      else toast.warning(t('pluginsPage.install.doneRefused', { name, reason: outcome.refused ?? '' }));
      for (const notice of childExecNotices(outcome, target.children ?? [])) toast.warning(notice);
      for (const notice of childVaultNotices(outcome, target.children ?? [])) toast.warning(notice);
      await Promise.all([onInstalled().catch(() => {}), loadCandidates()]);
    } catch (err) {
      if (isStalePreview(err)) await refresh(target, (err as Error).message);
      else toast.error(t('pluginsPage.install.failed'), { description: (err as Error).message });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="mt-4 flex flex-col gap-3" aria-label={t('pluginsPage.install.sectionLabel')}>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept={ARCHIVE_ACCEPT} className="hidden" onChange={(e) => void onFile(e)} />
        {picker
          ? (
            // Non-modal: its items end up opening the review dialog (TIM-0035).
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={staging !== null} className="gap-1.5">
                  <PackagePlus className="h-4 w-4" aria-hidden />
                  {staging ? t('pluginsPage.install.reading') : t('pluginsPage.install.button')}
                  <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => void pickNative('folder')} className="gap-2">
                  <FolderOpen className="h-4 w-4" aria-hidden />
                  {t('pluginsPage.install.pickFolder')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pickNative('archive')} className="gap-2">
                  <Archive className="h-4 w-4" aria-hidden />
                  {t('pluginsPage.install.pickArchive')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
          : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={staging !== null} className="gap-1.5">
                  <PackagePlus className="h-4 w-4" aria-hidden />
                  {staging ? t('pluginsPage.install.reading') : t('pluginsPage.install.button')}
                  <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => void pickOnDaemon('folder')} className="gap-2">
                  <FolderOpen className="h-4 w-4" aria-hidden />
                  {t('pluginsPage.install.pickFolderRemote')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pickOnDaemon('archive')} className="gap-2">
                  <Archive className="h-4 w-4" aria-hidden />
                  {t('pluginsPage.install.pickArchiveRemote')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => fileInput.current?.click()} className="gap-2">
                  <Upload className="h-4 w-4" aria-hidden />
                  {t('pluginsPage.install.uploadArchive')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        <p className="m-0 text-[12px] text-muted-foreground">
          {t(picker ? 'pluginsPage.install.hintDesktop' : 'pluginsPage.install.hintRemote')}
        </p>
      </div>

      {candidates.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t('pluginsPage.install.available', { count: candidates.length })}
          </h2>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 p-0">
            {candidates.map((candidate) => (
              <li key={candidate.name}>
                <button
                  type="button"
                  disabled={staging !== null}
                  onClick={() => void show(`detected:${candidate.name}`, () => stageDetected(candidate.name))}
                  className="flex w-full items-center gap-3 rounded-md bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
                  aria-label={t('pluginsPage.openDetails', { name: candidate.label ?? candidate.pkg })}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted/70">
                    {candidate.format === 'archive'
                      ? <Archive className="h-4 w-4 text-muted-foreground" aria-hidden />
                      : <Blocks className="h-4 w-4 text-muted-foreground" aria-hidden />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-[13px] font-medium">{candidate.label ?? candidate.pkg}</p>
                    <p className="m-0 truncate text-[11px] tabular-nums text-muted-foreground">
                      {candidate.pkg} · {candidate.version}
                      {staging === `detected:${candidate.name}` ? ` · ${t('pluginsPage.install.reading')}` : ''}
                    </p>
                    {candidate.kind.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {candidate.kind.map((kind) => <PluginKindBadge key={kind} kind={kind} />)}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {daemonPicker.dialog}

      <PluginInstallDialog
        preview={preview}
        open={open}
        busy={installing}
        notice={notice}
        onOpenChange={close}
        onInstall={(target, authorizeExec, vault, execChildren, vaultChildren) => void install(target, authorizeExec, vault, execChildren, vaultChildren)}
      />
    </section>
  );
}

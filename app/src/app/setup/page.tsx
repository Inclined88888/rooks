'use client';

/**
 * First-run wizard (plan §5.4, rewritten in step 5.7.4).
 *
 * This route intentionally lives outside `(main)`: onboarding must never
 * mount the product top bar, navigation, licence banner or plugin layout.
 *
 * Shown when `/api/capabilities` answers `firstRun: true` — no
 * `timon.config.json` on the daemon's machine. It is now BLOCKING: installing
 * the daemon as a service is mandatory, so this screen does not let anyone
 * through until the service answers. A wizard that wrote a config file next to
 * a dead daemon produced an install that looked finished and did nothing.
 *
 * Two things it no longer does. It no longer ASKS which supervisor to use —
 * the machine dictates that, and the screen states it. And it no longer only
 * advises: the buttons EXECUTE, falling back on the exact command to paste
 * when the daemon refuses to run one on the user's behalf (a `sudo`, a polkit
 * prompt nobody would see).
 *
 * The decision logic lives in `@/lib/setup-plan` — this file renders, it does
 * not decide, because only the former can be tested.
 *
 * Out of the normal parcours since the onboarding v2 (04/11/2026): the
 * onboarding installs the service in the background and writes the
 * configuration at its agent step (docs/ONBOARDING-PREPARATION.md). This
 * screen stays as the REPAIR screen — linked from the preparation card when
 * the service is refused, and reached by any old link.
 *
 * ONE DECISION AT A TIME. Until the daemon service answers, the service block
 * is the only thing on screen: nothing else is even clickable. `canFinish` is
 * the reveal condition, not `serviceInstalled` — a machine with no supervisor
 * can never register one, and gating on that would leave it staring at an
 * empty page. Once the service answers, the rest appears INLINE, in the same
 * page, with no re-login and no reboot to propose: `systemctl --user enable
 * --now` and `launchctl bootstrap gui/<uid>` both start it immediately, and
 * step onboarding.4 made `schtasks` do the same on Windows.
 */
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { useInstance } from '@/components/instance-provider';
import { OnboardingBackdrop } from '@/components/onboarding-backdrop';
import { BrandMark } from '@/components/brand-mark';
import { CommandToRun } from '@/components/command-to-run';
import {
  afterSetup,
  backendReady,
  shouldAutoWrite,
  answerMessage,
  apiKeyCards,
  backendCards,
  canFinish,
  noBackendInstalled,
  missingLogin,
  missingPrerequisites,
  needsHandover,
  PATH_DEFAULTS,
  serviceInstallable,
  supervisorToWrite,
  type OnboardingAnswer,
  type Prerequisite,
  type SetupDoctor,
} from '@/lib/setup-plan';
import { clearSetupDraft, loadSetupDraft, saveSetupDraft, shouldRefreshOnReturn } from '@/lib/setup-draft';
import { handOverToService } from '@/lib/desktop';
import { sessionDraftStorage } from '@/lib/ask-user-draft';
import { apiErrorMessage } from '@/lib/api-error';

async function onboarding(body: Record<string, unknown>): Promise<OnboardingAnswer> {
  const response = await fetch('/api/ui/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await response.json() as OnboardingAnswer;
}

export default function SetupPage() {
  const instance = useInstance();
  const [doctor, setDoctor] = useState<SetupDoctor | null>(null);
  const [serviceRunning, setServiceRunning] = useState(false);
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [serviceMessage, setServiceMessage] = useState<{ text: string; command: string | null; success?: boolean } | null>(null);
  const [showServiceDetails, setShowServiceDetails] = useState(false);
  const [prereqMessages, setPrereqMessages] = useState<Record<string, { text: string; command: string | null }>>({});
  // The edition is no longer asked: the screen writes the default, and
  // `/settings` remains where it changes. A licence can restrict it later.
  const edition = 'expert';
  const [appEnabled, setAppEnabled] = useState(false);
  const [binaries, setBinaries] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What this machine already holds. `firstRun` says only that
  // `timon.config.json` is missing, which is not the same question.
  const [existing, setExisting] = useState<{ present: boolean; agents: number; projects: number; missions: number } | null>(null);
  // The resume check has answered (or failed): until then, nothing is written on its own.
  const [resumeChecked, setResumeChecked] = useState(false);

  // When the machine was last read, for the refresh on return to the window.
  const lastRefreshAt = useRef(0);
  const refresh = useCallback(async () => {
    lastRefreshAt.current = Date.now();
    const response = await fetch('/api/ui/doctor', { cache: 'no-store' });
    const body = await response.json() as SetupDoctor & { binaries: SetupDoctor['binaries'] };
    setDoctor(body);
    if (body.desktop) setAppEnabled(true);
    // Detected paths are NOT prefilled any more. On a first run there is no
    // config, so every detection came from PATH: writing it back as a pin adds
    // no capability and creates a dead path the day the binary moves —
    // `whichBin` deliberately does not fall back to PATH for a pin. `binaries`
    // therefore carries only what the user typed in the recourse fields, which
    // are the only place a pin can still be seen and cleared.

    const status = await onboarding({ action: 'service-status' });
    setServiceRunning(status.ok);
    setServiceInstalled(status.installed === true);
    setServiceMessage(status.reason ? answerMessage(status) : null);

    // A failure here must not hold the wizard: the offer to resume is a
    // shortcut, and its absence leaves the normal parcours intact.
    try {
      const answer = await fetch('/api/ui/setup/resume', { cache: 'no-store' });
      if (answer.ok) {
        setExisting(await answer.json() as { present: boolean; agents: number; projects: number; missions: number });
      }
    } catch { /* the screen simply does not offer it */ }
    setResumeChecked(true);
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage((error as Error).message));
  }, [refresh]);

  // A reload must not empty the form (SUG-0006). Restored after mount, not in
  // the state initialiser: the server render has no sessionStorage.
  const draftRestored = useRef(false);
  useEffect(() => {
    const draft = loadSetupDraft(sessionDraftStorage());
    if (draft) {
      setBinaries(draft.binaries);
      if (draft.appEnabled) setAppEnabled(true);
    }
  }, []);
  useEffect(() => {
    // The first pass still holds the empty initial state, not the restored one.
    if (!draftRestored.current) { draftRestored.current = true; return; }
    saveSetupDraft(sessionDraftStorage(), { binaries, appEnabled });
  }, [binaries, appEnabled]);

  // Someone who installed a prerequisite in a terminal comes back to this
  // window: read the machine again without waiting for a click.
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    function onReturn() {
      if (!shouldRefreshOnReturn({
        visible: document.visibilityState === 'visible',
        busy: busyRef.current !== null,
        lastRefreshAt: lastRefreshAt.current,
        now: Date.now(),
      })) return;
      void refresh().catch((error: unknown) => setMessage((error as Error).message));
    }
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [refresh]);

  async function redetect() {
    setBusy('redetect');
    setMessage(null);
    try {
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function installService() {
    setBusy('service');
    setServiceMessage(null);
    setShowServiceDetails(false);
    try {
      const answer = await onboarding({ action: 'install-service' });
      // Windows may have registered the task and never started it for this
      // account (TODO #342): the doctor then reports no supervisor, and the
      // screen moves to the portable mode instead of offering the same task.
      if (!answer.ok) {
        const response = await fetch('/api/ui/doctor', { cache: 'no-store' });
        if (response.ok) setDoctor(await response.json() as SetupDoctor);
      }
      // Never trust the click: ask the machine what it now holds.
      const status = await onboarding({ action: 'service-status' });
      setServiceRunning(status.ok);
      setServiceInstalled(status.installed === true);
      setServiceMessage({ ...answerMessage(answer), success: answer.ok && status.installed === true });
    } catch (error) {
      setServiceMessage({ text: (error as Error).message, command: null });
    } finally {
      setBusy(null);
    }
  }

  async function installPrerequisite(name: string) {
    setBusy(`bin:${name}`);
    try {
      const answer = await onboarding({ action: 'install-binary', name });
      setPrereqMessages((prev) => ({ ...prev, [name]: answerMessage(answer) }));
      if (answer.ok) await refresh();
    } catch (error) {
      setPrereqMessages((prev) => ({ ...prev, [name]: { text: (error as Error).message, command: null } }));
    } finally {
      setBusy(null);
    }
  }

  /** Exactly what this screen holds right now, sent by both endings. */
  function answers() {
    return {
      edition,
      // The machine's answer, not a choice: this is what step 5.7.4 removed.
      supervisor: doctor ? supervisorToWrite(doctor) : 'none',
      appEnabled,
      binaries,
      vaultPath: PATH_DEFAULTS.vaultPath,
    };
  }

  /**
   * Ends onboarding on an instance that already exists. The daemon writes the
   * missing config — the only reason the gate held us here — and marks the
   * remaining steps answered; no agent is created and nothing is overwritten.
   * The full reload is deliberate: the first-run gate reads `capabilities`
   * once, and a client-side navigation would bounce straight back here.
   */
  async function resume() {
    setBusy('resume');
    setMessage(null);
    try {
      const response = await fetch('/api/ui/setup/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answers()),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiErrorMessage(body, t('setupPage.failed')));
      clearSetupDraft(sessionDraftStorage());
      // Resuming wrote the configuration too: on the desktop, the service takes over first.
      setBusy('handover');
      if (await handOverToService('/')) return;
      window.location.assign('/');
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await writeConfig();
  }

  async function writeConfig() {
    setBusy('config');
    setMessage(null);
    try {
      const response = await fetch('/api/ui/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answers()),
      });
      const body = await response.json() as { path?: string; error?: string; code?: string; teamOnboarding?: boolean };
      if (!response.ok) throw new Error(body.code === 'no_provider' ? t('setupPage.noProvider') : apiErrorMessage(body, t('setupPage.failed')));
      clearSetupDraft(sessionDraftStorage());
      // Step 3 runs on the daemon that stays: the desktop hands over to the
      // service it may still be running beside, then opens the next step itself.
      const next = afterSetup(body);
      setBusy('handover');
      if (await handOverToService(next)) return;
      window.location.assign(next);
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(null);
    }
  }

  const missing: Prerequisite[] = doctor ? missingPrerequisites(doctor) : [];
  const installable = doctor ? serviceInstallable(doctor) : false;
  const state = { doctor, serviceInstalled, serviceRunning };
  // The service is the only decision until it answers; `canFinish` is true as
  // soon as a supervisor is registered — or when the machine has none at all,
  // which is why it, and not `serviceInstalled`, opens the rest of the screen.
  const revealed = canFinish(state);
  // The daemon's own verdict, read from its blockers — never recomputed here.
  const noBackend = doctor ? noBackendInstalled(doctor) : false;
  const login = missingLogin(doctor);
  const cards = backendCards(doctor);
  // A backend that works as it stands leaves nothing to decide: the block goes.
  const ready = backendReady(doctor) && Object.keys(binaries).length === 0;
  const handover = needsHandover(state);

  // Nothing left to decide: move on without a click, once.
  const autoWritten = useRef(false);
  const auto = shouldAutoWrite({
    doctor, revealed, ready, missing: missing.length,
    resumable: resumeChecked ? existing?.present === true : null, message,
  });
  useEffect(() => {
    if (!auto || busy !== null || autoWritten.current) return;
    autoWritten.current = true;
    void writeConfig();
  // writeConfig reads the screen's current answers; it is not a dependency to watch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, busy]);

  return (
    <OnboardingBackdrop className="max-w-2xl" center step="setup">
    <div
      role="region"
      aria-labelledby="setup-title"
      tabIndex={0}
      className="group/setup w-full focus:outline-none"
    >
      {/* Keep a keyboard focus cue on the title rather than around the entire scroll pane. */}
      <h1 id="setup-title" className="text-2xl font-semibold group-focus-visible/setup:underline group-focus-visible/setup:decoration-primary group-focus-visible/setup:underline-offset-8">{t('setupPage.title', { name: instance.fullName })}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('setupPage.description')}</p>

      {/* Said before anything is configured, not after a failure three screens
          later: someone whose home already holds their work must be able to
          say so here, rather than discover it when the team step refuses. */}
      {existing?.present && (
        <section className="mt-6 space-y-3 rounded-xl border border-primary/40 bg-card p-4 text-sm shadow-elev-1">
          <h2 className="font-medium">{t('setupPage.resumeTitle')}</h2>
          <p className="text-muted-foreground">
            {t('setupPage.resumeFound', {
              agents: String(existing.agents),
              projects: String(existing.projects),
              missions: String(existing.missions),
            })}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void resume()}
              type="button"
            >
              {busy === 'resume' ? t('setupPage.resuming') : busy === 'handover' ? t('setupPage.handingOver') : t('setupPage.resume')}
            </button>
            <p className="text-xs text-muted-foreground">{t('setupPage.resumeHint')}</p>
          </div>
        </section>
      )}

      {/* No `This machine` panel: the user knows their own machine. The facts
          stay COLLECTED and reportable — `diagnose()` still gathers platform,
          distribution and supervisor, `timon doctor` and `/api/doctor` still
          serve them. Only the display is gone. */}
      {doctor && !installable && (
        <p className="mt-6 rounded-xl border border-destructive bg-card p-4 text-sm shadow-elev-1" role="alert">
          {t('setupPage.portableWarning')}
        </p>
      )}
      {/* Why the service was given up, when it was (TODO #342). */}
      {doctor && !installable && serviceMessage && !serviceMessage.success && (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{serviceMessage.text}</p>
      )}

      {installable && (
        <section className="mt-4 space-y-2 rounded-xl border border-border bg-card p-4 text-sm shadow-elev-1">
          <h2 className="font-medium">{t('setupPage.service')}</h2>
          <p className="text-xs text-muted-foreground">{t('setupPage.serviceWhy')}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p role="status">
              {serviceMessage?.success
                ? t('setupPage.serviceInstallSuccess')
                : serviceRunning
                  ? t('setupPage.serviceRunning')
                  : serviceInstalled ? t('setupPage.serviceInstalledNotRunning') : t('setupPage.serviceMissing')}
            </p>
            {serviceMessage?.success && serviceMessage.text && (
              <button
                type="button"
                className="rounded px-1 py-1 text-xs underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showServiceDetails}
                aria-controls="service-installation-details"
                onClick={() => setShowServiceDetails((shown) => !shown)}
              >
                {t(showServiceDetails ? 'setupPage.serviceHideDetails' : 'setupPage.serviceShowDetails')}
              </button>
            )}
          </div>
          {handover && <p className="text-xs text-muted-foreground">{t('setupPage.handoverHint')}</p>}
          {!serviceInstalled && (
            <div className="flex gap-2">
              <button
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void installService()}
                type="button"
              >
                {busy === 'service' ? t('setupPage.serviceInstalling') : t('setupPage.serviceInstall')}
              </button>
              <button
                className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void refresh()}
                type="button"
              >
                {t('setupPage.serviceRecheck')}
              </button>
            </div>
          )}
          {serviceMessage && (
            <div id="service-installation-details" className="text-xs" hidden={serviceMessage.success && !showServiceDetails}>
              <p className="whitespace-pre-wrap break-words">{serviceMessage.text}</p>
              {serviceMessage.command && <CommandToRun command={serviceMessage.command} />}
            </div>
          )}
        </section>
      )}

      {revealed && <>
      {/* Always shown, even when nothing is missing: someone who installs a
          CLI by hand needs the Re-detect button whatever the screen found
          before (SUG-0006). With nothing missing it is one line. */}
      <section className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4 text-sm shadow-elev-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-medium">{t('setupPage.prerequisites')}</h2>
          <button
            className="ml-auto rounded-md border px-2 py-1 text-xs disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void redetect()}
            type="button"
          >
            {busy === 'redetect' ? t('setupPage.redetecting') : t('setupPage.redetect')}
          </button>
        </div>
        <p className="text-xs text-muted-foreground" role="status">
          {missing.length === 0 ? t('setupPage.prerequisitesAllFound') : t('setupPage.redetectHint')}
        </p>
        {missing.map((item) => {
          const msg = prereqMessages[item.name];
          return (
            <div className="space-y-1" key={item.name}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {item.required ? t('setupPage.prerequisiteRequired') : t('setupPage.prerequisiteOptional')}
                </span>
                {item.installCommand && (
                  <button
                    className="ml-auto rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => void installPrerequisite(item.name)}
                    type="button"
                  >
                    {t('setupPage.prerequisiteInstall')}
                  </button>
                )}
              </div>
              {!item.installCommand && (
                <p className="text-xs text-muted-foreground">{t('setupPage.prerequisiteNoCommand')}</p>
              )}
              {msg && (
                <div className="text-xs">
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                  {msg.command && <CommandToRun command={msg.command} />}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <form className="mt-4 space-y-6 rounded-xl border border-border bg-card p-4 shadow-elev-1" onSubmit={submit}>
        {ready && <p className="text-sm text-muted-foreground" role="status">{t('setupPage.backendsReady')}</p>}
        {!ready && <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('setupPage.binaries')}</legend>
          <p className="text-xs text-muted-foreground">{t('setupPage.binariesHint')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {cards.map(({ name, label, brand }) => {
              const detected = doctor?.binaries.find((b) => b.name === name)?.ok === true;
              return (
                <div
                  className={`flex flex-col items-center gap-2 rounded-lg border p-3 text-center ${detected ? 'border-primary/40 bg-card' : 'border-border bg-card'}`}
                  key={name}
                >
                  <BrandMark brand={brand} className="h-7 w-7" />
                  <span className="text-sm font-medium">{label}</span>
                  {/* No badge at all on a backend that is simply not installed
                      while another one is: it is not an error, and the daemon
                      does not treat it as one. */}
                  {login?.binary === name ? (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                      {t('setupPage.backendLoginMissing')}
                    </span>
                  ) : detected ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                      {t('setupPage.backendDetected')}
                    </span>
                  ) : noBackend && (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                      {t('setupPage.backendMissing')}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="space-y-2 pt-2">
            <p className="text-xs font-medium">{t('setupPage.apiKeyTitle')}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {apiKeyCards(doctor).map(({ id, label, brand, via, viaLabel }) => {
                const cliReady = doctor?.binaries.find((b) => b.name === via)?.ok === true;
                return (
                  <div
                    className={`flex flex-col items-center gap-2 rounded-lg border p-3 text-center ${cliReady ? 'border-primary/40 bg-card' : 'border-border bg-card'}`}
                    key={id}
                  >
                    <BrandMark brand={brand} className="h-7 w-7" />
                    <span className="text-sm font-medium">{label}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t('setupPage.apiKeyVia', { cli: viaLabel })}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t('setupPage.apiKeyHint', { settingsPath: settingsPath('models', 'backends') })}</p>
          </div>
          {login && (
            <div className="space-y-2 text-sm" role="alert">
              <p>{t('setupPage.loginHint', { name: login.name, command: login.command ?? login.binary })}</p>
              {login.path && <p className="break-all text-xs">{t('setupPage.loginPath', { path: login.path })}</p>}
              {login.command && <CommandToRun command={login.command} />}
              <button type="button" className="rounded-md border px-3 py-1.5 text-xs" disabled={busy !== null}
                onClick={() => {
                  setBusy('login');
                  void refresh().catch((error: unknown) => setMessage((error as Error).message)).finally(() => setBusy(null));
                }}>
                {t('setupPage.serviceRecheck')}
              </button>
            </div>
          )}
          {/* The recourse appears only when the daemon itself says not one
              backend was found — its blocker, not a second rule computed here. */}
          {noBackend && (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              <p className="text-xs" role="alert">{t('setupPage.backendsNone')}</p>
              {cards.map(({ name, label }) => (
                <label className="block space-y-1" key={name}>
                  <span className="text-xs font-medium">{t('setupPage.backendPin', { name: label })}</span>
                  <input
                    className="w-full rounded-md border bg-background p-2 text-xs"
                    value={binaries[name] ?? ''}
                    onChange={(e) => setBinaries((prev) => ({ ...prev, [name]: e.target.value }))}
                    placeholder={t('setupPage.notFound')}
                  />
                </label>
              ))}
            </div>
          )}
        </fieldset>}

        {!doctor?.desktop && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={appEnabled} onChange={(e) => setAppEnabled(e.target.checked)} />
          <span>{t('setupPage.appEnabled')}</span>
        </label>}

        <button
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={busy !== null}
          type="submit"
        >
          {busy === 'config' ? t('setupPage.writing') : busy === 'handover' ? t('setupPage.handingOver') : t('setupPage.submit')}
        </button>
      </form>
      </>}

      {message && (
        <p className="mt-4 rounded-md border bg-card p-3 text-sm shadow-elev-1" role="alert">
          {message}
        </p>
      )}
    </div>
    </OnboardingBackdrop>
  );
}

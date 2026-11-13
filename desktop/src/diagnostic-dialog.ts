/**
 * Error boxes that hand over everything support needs in one gesture
 * (TODO #343): "Copy diagnostic", "Save report", "Open logs folder".
 *
 * `dialog.showErrorBox` has no buttons, hence `showMessageBox` everywhere.
 * The box comes back after each action and only OK closes it: on Linux the
 * clipboard belongs to the application and empties when it quits, and several
 * of these boxes are followed by `app.quit()`. "Save" writes a file that
 * survives on every OS.
 *
 * Each action answers in a box of its own (TIM-0117): a note appended to the
 * problem box that comes back almost unchanged read on Windows as "nothing
 * happened". And a click that has to wait for the report shows "Preparing
 * report…" instead of leaving the screen empty while the runner works.
 *
 * The report itself comes from the orchestrator's runner
 * (`diagnostic-report-runner.ts`, Electron as Node, no database): it works
 * whether the daemon answers or not. When the runner itself cannot run
 * (missing, crashed), a shorter report built here still carries the error,
 * the versions and the desktop log.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localTimestamp, logDir, parseDatedLog } from './desktop-log.js';
import { shellText } from './shell-i18n.js';

export type DiagnosticReport = { text: string; findings: string[] };

export type DiagnosticCopy = {
  ok: string;
  copy: string;
  save: string;
  open: string;
  copied: string;
  saved: (path: string) => string;
  failed: (what: string) => string;
  copiedTitle: string;
  savedTitle: string;
  showInFolder: string;
  copyFailed: string;
  saveFailed: string;
  openFailed: string;
  preparing: string;
  preparingDetail: string;
  cancel: string;
  findings: string;
  trayItem: string;
  trayMessage: string;
  trayDetail: string;
};

export function diagnosticCopy(locale: string, platform: NodeJS.Platform): DiagnosticCopy {
  const t = shellText(locale);
  return {
    ok: 'OK',
    copy: t('diagnostic.copy'),
    save: t('diagnostic.save'),
    open: t('diagnostic.open'),
    copied: t(platform === 'linux' ? 'diagnostic.copiedLinux' : 'diagnostic.copied'),
    saved: (path) => t('diagnostic.saved', { path }),
    failed: (what) => t('diagnostic.failed', { what }),
    copiedTitle: t('diagnostic.copiedTitle'),
    savedTitle: t('diagnostic.savedTitle'),
    showInFolder: t('diagnostic.showInFolder'),
    copyFailed: t('diagnostic.copyFailed'),
    saveFailed: t('diagnostic.saveFailed'),
    openFailed: t('diagnostic.openFailed'),
    preparing: t('diagnostic.preparing'),
    preparingDetail: t('diagnostic.preparingDetail'),
    cancel: t('diagnostic.cancel'),
    findings: t('diagnostic.findings'),
    trayItem: t('diagnostic.item'),
    trayMessage: t('diagnostic.title'),
    trayDetail: t('diagnostic.detail'),
  };
}

export type ProblemBox = { type: 'error' | 'warning' | 'info'; title: string; message: string; detail: string };

/** Settings › System opens the same folder as the boxes. */
export const OPEN_LOGS_CHANNEL = 'rooks:open-logs';

export type BoxOptions = ProblemBox & { buttons: string[]; defaultId: number; cancelId: number; noLink: boolean; signal?: AbortSignal };

/**
 * OK first: it is the default (Enter) and the cancel (Escape) on every OS,
 * stated explicitly because macOS otherwise picks by label. `noLink` keeps
 * Windows from turning the other buttons into command links.
 */
export function problemBoxOptions(box: ProblemBox, copy: DiagnosticCopy, extra: string[]): BoxOptions {
  return {
    ...box,
    detail: [box.detail, ...extra].filter(Boolean).join('\n\n'),
    buttons: [copy.ok, copy.copy, copy.save, copy.open],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export type ProblemDeps = {
  show: (options: BoxOptions) => Promise<{ response: number }>;
  /** Started as soon as the problem is known; awaited by the actions. */
  report: () => Promise<DiagnosticReport>;
  writeClipboard: (text: string) => void;
  /** Writes the report where it lasts, returns its path. */
  save: (text: string) => string;
  /** `shell.showItemInFolder`: the saved file, selected in the file manager. */
  showInFolder: (path: string) => void;
  /** `shell.openPath` of the logs folder: '' on success, else its error. */
  openLogs: () => Promise<string>;
  log: (line: string) => void;
  copy: DiagnosticCopy;
  /** How long the first box waits for the findings before showing without them. */
  findingsWaitMs?: number;
};

type Settled = { report: DiagnosticReport } | { error: Error };

/** A one-off answer to an action: OK only, unless `buttons` says otherwise. */
function answerBox(box: ProblemBox, buttons: string[]): BoxOptions {
  return { ...box, buttons, defaultId: 0, cancelId: 0, noLink: true };
}

/**
 * The report, or null when the user cancelled the wait. A pending report gets
 * a "Preparing report…" box, closed by its signal once the report settles;
 * where the signal cannot close it (macOS, no parent window), the user's click
 * does, and a report that settled meanwhile still counts.
 */
async function awaitReport(deps: ProblemDeps, title: string, pending: Promise<DiagnosticReport>, settled: () => Settled | null): Promise<Settled | null> {
  const now = settled();
  if (now) return now;
  const controller = new AbortController();
  const done = pending.then(() => undefined, () => undefined).then(() => controller.abort());
  await deps.show({
    ...answerBox({ type: 'info', title, message: deps.copy.preparing, detail: deps.copy.preparingDetail }, [deps.copy.cancel]),
    signal: controller.signal,
  });
  const after = settled();
  if (!after) return null;
  await done;
  return after;
}

/** Shows the box until OK; each action answers in a box of its own, then the problem box comes back. */
export async function showProblem(deps: ProblemDeps, box: ProblemBox): Promise<void> {
  deps.log(`[desktop] ${box.type} shown: ${box.message} — ${box.detail.replace(/\s*\n+\s*/g, ' ')}`);
  const started = Date.now();
  let state: Settled | null = null;
  const pending = deps.report();
  pending.then(
    (report) => { state = { report }; deps.log(`[desktop] diagnostic report ready in ${Date.now() - started} ms`); },
    (error: Error) => { state = { error }; deps.log(`[desktop] diagnostic report failed after ${Date.now() - started} ms: ${error.message}`); },
  );
  const early = await Promise.race([
    pending.then((report) => report, () => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), deps.findingsWaitMs ?? 4000).unref?.()),
  ]);
  const findings = early?.findings.length ? `${deps.copy.findings}\n${early.findings.map((f) => `• ${f}`).join('\n')}` : '';
  if (early) for (const finding of early.findings) deps.log(`[desktop] finding: ${finding}`);
  let note = '';
  for (;;) {
    const { response } = await deps.show(problemBoxOptions(box, deps.copy, [findings, note]));
    if (response === 1 || response === 2) {
      const result = await awaitReport(deps, box.title, pending, () => state);
      if (!result) continue;
      const failedTitle = response === 1 ? deps.copy.copyFailed : deps.copy.saveFailed;
      try {
        if ('error' in result) throw result.error;
        if (response === 1) {
          deps.writeClipboard(result.report.text);
          // Before the box can close: a quit that follows takes a Linux clipboard with it (TODO #478).
          deps.log(`[desktop] diagnostic copied to the clipboard (${result.report.text.length} characters)`);
          note = deps.copy.copied;
          await deps.show(answerBox({ type: 'info', title: box.title, message: deps.copy.copiedTitle, detail: deps.copy.copied }, [deps.copy.ok]));
        } else {
          const path = deps.save(result.report.text);
          note = deps.copy.saved(path);
          deps.log(`[desktop] diagnostic report saved to ${path}`);
          const { response: shown } = await deps.show(answerBox(
            { type: 'info', title: box.title, message: deps.copy.savedTitle, detail: path },
            [deps.copy.ok, deps.copy.showInFolder],
          ));
          if (shown === 1) deps.showInFolder(path);
        }
      } catch (error) {
        const reason = (error as Error).message;
        note = deps.copy.failed(reason);
        deps.log(`[desktop] diagnostic ${response === 1 ? 'copy' : 'save'} failed: ${reason}`);
        await deps.show(answerBox({ type: 'error', title: box.title, message: failedTitle, detail: reason }, [deps.copy.ok]));
      }
      continue;
    }
    if (response === 3) {
      const failure = await deps.openLogs().catch((error: Error) => error.message);
      note = failure ? deps.copy.failed(failure) : '';
      // A folder window that opens is its own answer; only a failure needs a box.
      if (failure) await deps.show(answerBox({ type: 'error', title: box.title, message: deps.copy.openFailed, detail: failure }, [deps.copy.ok]));
      continue;
    }
    return;
  }
}

/** `<home>/tmp/rooks-diagnostic-<stamp>.txt`: in the logs folder the box offers to open. */
export function saveReport(home: string, text: string, now: Date = new Date()): string {
  const dir = logDir(home);
  mkdirSync(dir, { recursive: true });
  const stamp = localTimestamp(now).slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const path = join(dir, `rooks-diagnostic-${stamp}.txt`);
  writeFileSync(path, text);
  return path;
}

/** The desktop log's last lines, newest first: the fallback report's core. */
export function recentDesktopLines(home: string, count: number): string[] {
  const dir = logDir(home);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const files = names.flatMap((name) => {
    const parsed = parseDatedLog(name);
    return parsed?.kind === 'desktop' ? [{ name, ...parsed }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day) || b.part - a.part);
  const lines: string[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file.name);
      const size = statSync(path).size;
      const text = size > 512 * 1024 ? readFileSync(path, 'utf8').slice(-512 * 1024) : readFileSync(path, 'utf8');
      lines.push(...text.split(/\r?\n/).filter((line) => line.trim()).reverse());
    } catch { /* unreadable: skip */ }
    if (lines.length >= count) break;
  }
  return lines.slice(0, count);
}

/** When the runner cannot run: the error, the versions, the desktop log. No secret is read here. */
export function fallbackReport(input: { home: string; appVersion: string; platform: NodeJS.Platform; error: string; why: string; now?: Date }): DiagnosticReport {
  const text = [
    `Rooks diagnostic report — ${localTimestamp(input.now)} (from the desktop app, reduced: ${input.why})`,
    'Logs are newest first.',
    '', '== Error shown ==', input.error,
    '', '== Versions ==', `app       ${input.appVersion}`, `runtime   Electron ${process.versions.electron ?? '?'}, Node ${process.versions.node}`,
    '', '== System ==', `os        ${input.platform}`, `home      ${input.home}`, `logs      ${logDir(input.home)}`,
    '', '== Desktop log (newest first) ==', ...recentDesktopLines(input.home, 100),
  ].join('\n') + '\n';
  return { text, findings: [] };
}

export type RunnerInput = { execPath: string; resourcesPath: string; env: NodeJS.ProcessEnv; error: string };

export function diagnosticRunnerPath(resourcesPath: string): string {
  return join(resourcesPath, 'orchestrator', 'dist', 'host', 'diagnostic-report-runner.js');
}

/** Runs the orchestrator's runner; rejects with a short reason, never the minified stack. */
export function runDiagnosticRunner(input: RunnerInput): Promise<DiagnosticReport> {
  const runner = diagnosticRunnerPath(input.resourcesPath);
  if (!existsSync(runner)) return Promise.reject(new Error('the diagnostic runner is not in this build'));
  return new Promise((resolve, reject) => {
    execFile(input.execPath, [runner, '--error', input.error.slice(0, 4000)], {
      env: input.env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(new Error(`the diagnostic runner failed (${error.message.split('\n')[0]})`)); return; }
      try {
        const parsed = JSON.parse(stdout.toString()) as { text?: unknown; findings?: unknown };
        if (typeof parsed.text !== 'string' || !Array.isArray(parsed.findings)) throw new Error('unexpected output');
        resolve({ text: parsed.text, findings: parsed.findings.map((f) => String((f as { text?: unknown }).text ?? f)) });
      } catch (e) {
        reject(new Error(`the diagnostic runner answered nonsense (${(e as Error).message})`));
      }
    });
  });
}

/**
 * What the publication card and the Git widget's header say about a branch
 * (bugs #22-#24): a count that did not resolve is unknown, never zero; a
 * detached HEAD is not a branch to push; a branch never pushed is not
 * published whatever its gap to the default branch.
 */

import type { ConfirmRequest } from '@/components/confirm-dialog/confirm-dialog-context';
import type { GitRemote, GitRemoteTarget } from '@/lib/git-store';
import { t } from '@/lib/i18n';

/** What the card says about one branch's publication. */
export type PublishView = {
  /** The project has a remote it can push to. */
  published: boolean;
  /** HEAD is detached and no branch was picked: nothing to push as such. */
  detached: boolean;
  /** Commits not on the remote; null = the comparison did not resolve. */
  ahead: number | null;
  behind: number | null;
  /** The branch itself exists on the remote. */
  branchPublished: boolean;
  upstream: string | null;
  compareRef: string | null;
};

export function publishView(g: GitRemote, selected: string | null): PublishView {
  const published = g.state !== 'no-remote' && g.state !== 'not-a-repo';
  const other = selected && selected !== g.branch ? g.branches.find((b) => b.name === selected) ?? null : null;
  if (other) {
    return {
      published, detached: false, ahead: other.ahead, behind: other.behind,
      branchPublished: other.published, upstream: other.upstream, compareRef: other.compare_ref,
    };
  }
  // On the current branch `g.ahead` wins: it is counted with the default
  // branch fallback of the daemon, more reliable than a `for-each-ref` row.
  return {
    published, detached: published && !g.branch, ahead: g.ahead, behind: g.behind,
    branchPublished: g.branch_published, upstream: g.upstream, compareRef: g.compare_ref,
  };
}

/** The dot of the card and of the widget header: red = not published at all,
 *  amber = something to send or unknown, green = nothing waiting. */
export function publishTone(v: PublishView): 'red' | 'amber' | 'green' {
  if (!v.published) return 'red';
  if (v.detached || v.ahead === null || v.ahead > 0 || !v.branchPublished) return 'amber';
  return 'green';
}

export const TONE_DOT = { red: 'bg-red-400', amber: 'bg-amber-400', green: 'bg-emerald-400' } as const;

/**
 * The remote a push of `branch` reaches when none is named — the daemon's own
 * rule: the remote its upstream lives on, otherwise `origin`, otherwise the
 * first declared one. The picker preselects it, and only another choice is
 * sent (and confirmed).
 */
export function defaultPushRemote(g: GitRemote, branch: string | null): string | null {
  const remotes = g.remotes ?? [];
  if (remotes.length === 0) return g.remote_name;
  const upstream = g.branches.find((b) => b.name === branch)?.upstream ?? null;
  if (upstream) {
    // The longest name wins: `a/b` and `a` can both prefix `a/b/main`.
    const owner = remotes.filter((r) => upstream.startsWith(`${r.name}/`))
      .sort((x, y) => y.name.length - x.name.length)[0];
    if (owner) return owner.name;
  }
  return remotes.some((r) => r.name === 'origin') ? 'origin' : remotes[0]!.name;
}

/** What `branch` lacks on `remote`; null when the daemon did not say. */
export function remotePending(
  g: GitRemote,
  remote: string | null,
  branch: string | null,
): { target: GitRemoteTarget; published: boolean; ahead: number | null } | null {
  const target = (g.remotes ?? []).find((r) => r.name === remote);
  const row = target?.branches.find((b) => b.name === branch);
  return target && row ? { target, published: row.published, ahead: row.ahead } : null;
}

/** What a push is about to do, as the confirmation reads it. */
export type PushPlan = {
  /** The repository's name when the project holds several; null = say nothing. */
  repo: string | null;
  branch: string;
  remote: string;
  /** The destination as one reads it, `owner/name`. */
  url: string;
  /** The remote is the one the branch tracks (or would track). */
  upstream: boolean;
  /** The branch already exists on that remote. */
  published: boolean;
  /** Commits that remote lacks; null = unknown. */
  ahead: number | null;
};

/**
 * The question asked before every push: a push cannot be taken back, so the
 * destination is always spelled out (repository, remote, url, branch, count),
 * and a remote other than the upstream is painted as a danger.
 */
export function pushConfirmation(p: PushPlan): ConfirmRequest {
  const vars = { branch: p.branch, remote: p.remote, url: p.url };
  const title = !p.published
    ? t('gitWidget.publish.confirmPublishTitle', vars)
    : p.ahead === null
      ? t('gitWidget.publish.confirmPushTitle', vars)
      : t('gitWidget.publish.confirmPushCountTitle', { ...vars, count: p.ahead });
  const body = p.upstream
    ? !p.published
      ? t('gitWidget.publish.confirmUpstreamAbsent', vars)
      : p.ahead === null
        ? t('gitWidget.publish.confirmUpstreamUnknown', vars)
        : t('gitWidget.publish.confirmUpstream', vars)
    : !p.published
      ? t('gitWidget.publish.confirmPushAbsent', vars)
      : p.ahead === null
        ? t('gitWidget.publish.confirmPushUnknown', vars)
        : t('gitWidget.publish.confirmPushCount', { ...vars, count: p.ahead });
  const where = p.repo ? `${t('gitWidget.publish.confirmRepo', { repo: p.repo })} ` : '';
  return {
    title,
    description: where + (p.upstream ? body : `${t('gitWidget.publish.confirmNotUpstream', vars)} ${body}`),
    confirmLabel: p.upstream
      ? t(p.published ? 'gitWidget.publish.push' : 'gitWidget.publish.publishBranch')
      : t('gitWidget.publish.pushTo', { remote: p.remote }),
    destructive: !p.upstream,
  };
}

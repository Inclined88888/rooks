---
title: Git
sidebar_position: 4.8
---

A project's Git repository shows in two places of an agent's chat: the **Git** widget, in the right column by default, and the branch shown above the message box. Both read the same state: switch a branch in one, and the other follows. They come with the built-in **Git** plugin, which needs Git installed on the machine where Rooks's daemon runs.

Git is read again after your own actions (switch, push, fetch, saving a remote), at the end of each agent turn, and when you come back to the window. A branch switched in a terminal shows when you return to Rooks; **Refresh** in the widget reads it at once.

## The Git widget

The widget's header gives the current branch (or **detached HEAD**), the number of uncommitted changes, and where the branch stands against its remote: *N to push*, *not published*, *no remote*, *up to date*, or *count unknown*. An agent without a project has no repository to show.

Below the header, three tabs:

- **Branches** — the working tree (files changed since the last commit), then the local branches. Click a branch to switch the project to it; with uncommitted changes, Rooks asks first. A branch checked out in another worktree carries **worktree** and cannot be switched to from here. **local only** marks a branch that was never pushed: its commits only exist on this disk.
- **Graph** — the commit history, described below.
- **Publish** — the remote, the branch and its gap, and the buttons to publish it, described below. The **lite** configuration preset hides this tab.

### Several repositories in one project

A project folder can hold more than one Git repository: a notes repository nested inside the project and ignored by it, for instance. The widget finds, besides the project's own repository, every first-level folder that is a repository the project ignores, and every repository folder listed in the project's `.worktreelinks` file.

When there is more than one, a **Repository** picker appears in the widget's toolbar. The project's own repository, marked **(root)**, is shown by default; pick another and the header, the three tabs and their buttons (switch, push, fetch, remotes) all work on that one. An amber dot beside the picker means another repository of the project has commits to push: hover it to see which and how many, click it to show that repository.

The branch above the message box always shows the project's own repository.

The widget is a card like any other: move it, or put it back, from the chat's widget columns.

## The commit graph

The **Graph** tab draws the latest 150 commits of every local branch, remote branch and tag, newest first. Each line of development keeps its own colour; a ring marks the commit you are on, a hollow dot a merge.

Each commit shows its labels (branches, tags, worktrees — two at most, then **+N**), its subject, then its short hash, author and age. A branch whose remote copy points at the same commit shows once, marked *same commit on the remote*. A worktree on a detached HEAD gets a label of its own.

Click a commit to open its detail under the list: the full hash with a **Copy** button, the author, the date, every label, and its parents — click one to jump to it.

The history is only read while the tab is on screen.

## The branch above the message box

Above the message box, the bar shows where the conversation's agent works:

```text
main · rooks · ● · +12 −3
```

That is the branch, the folder (the worktree's folder when the agent works in one), a dot when there are uncommitted changes, and the lines added and removed against the last commit. Files Git does not track yet are not counted. In the compact chat layout, the folder is left out.

Click the bar to open **Branches and worktrees**:

- **Branches** — every branch, the current one marked, with its commits ahead and behind and its last subject. Pick one to switch the project to it, as from the widget. A branch held by another worktree is marked **worktree** and cannot be picked.
- **Worktrees** — every worktree of the repository: its name, its branch or detached HEAD, and **main checkout**, **here** (where this conversation works), **locked** or **missing**. Hover one to see its full path. Worktrees are listed for information; they have no action.

When the conversation works in a worktree of its own (a Kanban coding task, for instance), no branch can be picked: switching would move the project's main checkout, not the folder the agent works in. The menu says so; switch the branch from that folder instead.

The same goes for an agent whose folder is another Git repository than its project's: the menu lists the project's branches for information, none can be picked, and none is marked as the conversation's.

## Publishing a branch

The **Publish** tab compares the current branch with its remote:

- **to push** — commits the remote does not have yet. **Push** sends them.
- **not published** — the branch was never pushed. **Publish** pushes it and sets its upstream; the gap is measured against the remote's default branch.
- **ahead** — on a detached HEAD, the gap against the remote's default branch. Pick a branch to push.
- **unknown** — the branch Rooks compares with cannot be found (its remote copy was deleted, or the remote has no default branch). The count is unknown, not zero, and pushing stays possible.
- **behind** — commits on the remote you do not have. **Fetch** brings them and refreshes the count.

A folder that is not a Git repository, or a repository without a commit, says what to do before anything can be published.

Every push asks first, and says where the code goes: the repository (when the project holds several), the remote and its short URL, the branch and the number of commits, for instance *Push 12 commits of main to acme/shop?*. Nothing leaves your machine until you confirm.

### Choosing where to push

When the repository has more than one remote, a destination picker sits beside **Push**. It starts on the remote the branch tracks (marked **upstream**), and pushing there works as described above. Each entry gives the remote's short URL and what it lacks of the branch: *N to push*, *up to date*, or *branch absent* when the branch was never pushed there.

Pick another remote and the button reads **Push to** *remote*. The confirmation then warns that this remote is not the branch's upstream, and names it and how many commits will be published: once pushed, the history exists there and cannot be taken back. Pushing elsewhere never changes the branch's upstream. The counts are read from what Rooks last saw of each remote, at the last push or fetch.

## Remotes

The remote is where a project's code is pushed and fetched from. Without one, the **Publish** tab offers **Add a remote…** and **Create on GitHub…**, which creates the repository (private or public) and pushes the branch; the latter needs the [GitHub CLI](https://cli.github.com/) (`gh`) installed and signed in. With a remote, **Remotes…** sits next to **Fetch**.

**Remotes…** lists every remote of the project: its name, its URL, a separate push URL when it has one, and which one pushes go to. From there you can:

- **Add a remote** — a name (`origin` is proposed for the first one) and a URL;
- **Change the URL** of a remote;
- **Remove** a remote, after a second click to confirm.

Any Git server works — GitHub, GitLab, Gitea, Forgejo, Bitbucket or your own. The URL can be:

| Kind | Example |
|---|---|
| SSH | `git@gitlab.com:team/project.git`, `ssh://git@git.example.com:2222/team/project.git` |
| HTTPS, without credentials | `https://gitea.example.com/team/project.git` |
| Git protocol | `git://git.example.com/project.git` |
| Local | `file:///srv/git/project.git`, or an absolute folder on this machine |

**A URL never carries a secret.** An HTTPS URL with a user name or a token in it is refused, before it leaves the field. Secrets stay with Git:

- **SSH** — a key in `~/.ssh` of the account the daemon runs under, usable without a passphrase prompt: Rooks's daemon runs in the background and may not reach the SSH agent of your desktop session. The server's host key must already be known: connect once from a terminal (`ssh -T git@gitlab.com`) to accept it.
- **HTTPS** — Git's credential helper (Git Credential Manager, the macOS keychain, `gh auth setup-git`…), set up for that same account. On macOS, a helper that reads the keychain fails while no session is open; prefer SSH there.

After saving, Rooks checks that the remote answers. An unreachable remote is still saved: the dialog shows Git's own message (missing key, unknown host, repository not found) so you can fix the cause and save again. A URL that already held credentials before — set outside Rooks — is shown with them masked.

Adding, changing or removing a remote needs the **Create, update and delete projects** permission: a remote decides where the code goes.

## Who may change a repository

Anyone signed in can read a project's branches, graph and publication state. Everything that changes the repository or what is published needs the **Create, update and delete projects** permission: switching or deleting a branch, pushing, fetching, creating the repository on GitHub, and editing the remotes. Without it, these buttons are greyed out and say which permission to ask an administrator for, in the Git panel, the branch menu above the message box and the project cards. An agent acts with the rights of the account that launched it.

## Related pages

- [Projects](projects.md) — how a project's folder and worktrees are organised.
- [Kanban](kanban.md) — coding tasks run in worktrees of their own.
- [Built-in terminal](terminal.md) — for the Git commands the widget does not cover.

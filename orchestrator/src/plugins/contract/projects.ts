/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { ProjectEventOrigin } from './origin.js';

// Moved from `projects.ts`, which re-exports it (TODO #512, volet 3).
export type TaskRole = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';

/** A project as a plugin sees it. `cwd` is `null` unless the caller may manage projects. */
export type PluginProject = Readonly<{
  slug: string;
  name: string | null;
  color: string | null;
  /** An emoji or short code, or a picture the daemon serves (`/api/uploads/projects/…`). */
  icon: string | null;
  workspace: string | null;
  cwd: string | null;
  speech: string | null;
  kind: string | null;
  status: string;
  /** Epoch ms of the last mission that completed on it, or `null`. */
  lastActivity: number | null;
  /** `plugin:<id>` when a plugin registered it, `null` for any other project. */
  createdBy: string | null;
  /** Registered by THIS plugin: `update` and `setRole` accept it. */
  mine: boolean;
}>;

/** A pole that groups projects. */
export type PluginWorkspace = Readonly<{
  slug: string;
  name: string;
  color: string | null;
  leadAgent: string | null;
  /** Slugs of the projects it holds. */
  projects: readonly string[];
}>;

export type PluginProjectInput = {
  /** Letters, digits, dots, dashes, underscores; ≤ 64 characters. */
  slug: string;
  name?: string;
  /** `#RRGGBB`; derived from the name when omitted. */
  color?: string;
  /** An emoji or short code (32 characters at most), or a picture uploaded to the
   *  daemon (`/api/uploads/projects/…`); a web address is refused (`invalid`). */
  icon?: string;
  /** An EXISTING pole (matched ignoring case), unless `createWorkspace`. */
  workspace?: string;
  /** Absolute path of an existing directory on the host. */
  cwd?: string;
  speech?: string;
  /** `client` | `perso` — free text, empty clears. */
  kind?: string;
  status?: string;
  /** Create `workspace` when it does not exist yet. Default false. */
  createWorkspace?: boolean;
};

/** Fields of `PluginProjectInput` to change; an empty string clears `workspace`, `speech`, `icon`, `kind`. */
export type PluginProjectPatch = Partial<Omit<PluginProjectInput, 'slug' | 'cwd'>> & {
  /** Accepted only while the project has no working directory yet. */
  cwd?: string;
};

/** What the daemon cannot use of a write, without refusing it (a superadmin's cwd). */
export type PluginProjectWarning = Readonly<{ field: 'cwd'; code: string; path: string; message: string }>;

export type PluginProjectWrite = Readonly<{ project: PluginProject; warnings: readonly PluginProjectWarning[] }>;

/** What a task role is run by: the agent plus its optional LLM choice. */
export type PluginRoleSpec = Readonly<{
  agent: string;
  backend?: string | null;
  model?: string | null;
  permissionMode?: string | null;
}>;

export type PluginRoleInput = {
  agent: string;
  backend?: string;
  model?: string;
  /** `default`, `acceptEdits`, `plan` or `auto`; anything higher is a superadmin's. */
  permissionMode?: string;
};

export type PluginProjectRoles = Readonly<Partial<Record<TaskRole, PluginRoleSpec>>>;

/** `invalid` (input), `not_found` (no such project, or it is not visible),
 *  `forbidden` (not this plugin's project, or a refusal of the caller's rights). */
export type PluginProjectErrorCode = 'invalid' | 'not_found' | 'forbidden';

export type PluginProjectEventKind = 'project_created' | 'project_updated';

/** Who wrote the project: `user` (account id), `agent` (name), `plugin` (plugin id), `system` (`id: null`). */
export type PluginProjectOrigin = ProjectEventOrigin;

export type PluginProjectCreatedEvent = Readonly<{
  kind: 'project_created';
  slug: string;
  project: PluginProject;
  origin: PluginProjectOrigin;
}>;

export type PluginProjectUpdatedEvent = Readonly<{
  kind: 'project_updated';
  slug: string;
  /** The fields written (`name`, `workspace`…), or `roles` for a role pin. */
  changed: readonly string[];
  project: PluginProject;
  origin: PluginProjectOrigin;
}>;

export type PluginProjectEvent = PluginProjectCreatedEvent | PluginProjectUpdatedEvent;

export type PluginProjectEventMap = {
  project_created: PluginProjectCreatedEvent;
  project_updated: PluginProjectUpdatedEvent;
};

export type PluginProjectEventHandler = (ev: PluginProjectEvent) => void | Promise<void>;

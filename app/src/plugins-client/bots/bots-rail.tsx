'use client';

/**
 * The rail of bots: the main agent on top, then the bots grouped by team, and
 * at the foot one bar holding the search, "New bot", "New team" and what
 * plugins add there (`bots.rail.action`, "Import").
 *
 * A click selects the bot whose chat is shown. The "…" of a row, or a right
 * click on it, opens the bot's menu: its team, then what plugins add
 * (`agent.menu.item`, "Export").
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, Search, Trash2, UserMinus, UsersRound, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ActiveAgentAvatar, AgentAvatar, agentIdentity } from '@/components/agent-avatar';
import type { ActiveState } from '@/lib/agent-state';
import { t } from '@/lib/i18n';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { SlotRegion, useSlotEntries } from '@/lib/plugin-host/render';
import { cn } from '@/lib/utils';
import { AGENT_MENU_SLOT, AgentMenuSlot } from './agent-menu-slot';
import { addMember, removeMember } from './teams-api';
import { TeamDialog, removeTeam, type TeamEditing } from './teams-menu';
import { NO_TEAM, mainBotOf, type Bot, type Team } from './types';

export type BotGroup = { key: string; team: Team | null; bots: Bot[] };

/** Teams first (alphabetical), the team-less bots last. The main agent is
 *  pinned above every group by the rail itself, never inside one. */
export function groupBots(bots: Bot[], teams: Team[]): BotGroup[] {
  const byTeam = new Map<string, Bot[]>();
  const main = mainBotOf(bots);
  for (const bot of bots) {
    if (bot.name === main) continue;
    const key = bot.team ?? NO_TEAM;
    const list = byTeam.get(key);
    if (list) list.push(bot); else byTeam.set(key, [bot]);
  }
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  const groups: BotGroup[] = sorted.map((team) => ({
    key: team.id,
    team,
    bots: (byTeam.get(team.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  // A team a bot points to but the viewer cannot see (scoped list, or a team
  // deleted between two reads) must not swallow that bot: it falls back into
  // the team-less section rather than disappearing from the rail.
  const known = new Set(sorted.map((team) => team.id));
  const loose = [...byTeam.entries()]
    .filter(([key]) => key === NO_TEAM || !known.has(key))
    .flatMap(([, list]) => list)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (loose.length > 0) groups.push({ key: NO_TEAM, team: null, bots: loose });
  return groups;
}

/** Whether a bot answers the search: its name or its role, case and accents ignored. */
export function botMatches(bot: Bot, query: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  if (q.length === 0) return true;
  return fold(bot.name).includes(q) || fold(bot.role ?? '').includes(q);
}

/**
 * The groups the rail shows for a search: the bots that answer it, under
 * their team. While searching, a team with no match is dropped; without a
 * search an empty team stays, as the place to move bots into.
 */
export function visibleGroups(groups: readonly BotGroup[], query: string): BotGroup[] {
  if (query.trim().length === 0) return [...groups];
  return groups
    .map((group) => ({ ...group, bots: group.bots.filter((bot) => botMatches(bot, query)) }))
    .filter((group) => group.bots.length > 0);
}

/** Look of the foot bar's tooltips; a plugin's button in `bots.rail.action` copies it. */
export const RAIL_TIP = 'rounded-md bg-popover px-2 py-1 text-[11.5px] font-medium text-popover-foreground shadow-elev-2';

/** A foot bar control with its name in a tooltip (the icon alone says little). */
function RailTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className={RAIL_TIP}>{label}</TooltipContent>
    </Tooltip>
  );
}

const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Drag type of a bot row: only the rail's own sections accept it. */
export const BOT_DRAG_TYPE = 'application/x-timon-bot';

type MenuPlace = { x: number; y: number; align: 'start' | 'end' };

/** What a menu of the rail was opened on, and where. */
type RailMenu =
  | ({ kind: 'bot'; bot: Bot; pinned: boolean } & MenuPlace)
  | ({ kind: 'team'; team: Team } & MenuPlace)
  | ({ kind: 'blank' } & MenuPlace);

/** A right click: the menu opens under the pointer. */
function atPointer(e: React.MouseEvent): MenuPlace {
  return { x: e.clientX, y: e.clientY, align: 'start' };
}

/** A "…": the menu hangs from the button, right edges aligned. */
function atButton(el: HTMLElement): MenuPlace {
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.bottom, align: 'end' };
}

/** A right click the rail takes over: not the browser's menu, and not a parent's either. */
function claim(e: React.MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function MoreButton({ label, open, onOpen, className }: {
  label: string;
  open: boolean;
  onOpen: (place: MenuPlace) => void;
  className?: string;
}) {
  // A press on the button of an open menu closes it (outside press) before
  // the click lands: that click must not open it again.
  const wasOpen = useRef(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-open={open}
      onPointerDown={() => { wasOpen.current = open; }}
      onClick={(e) => {
        e.stopPropagation();
        if (wasOpen.current) { wasOpen.current = false; return; }
        onOpen(atButton(e.currentTarget));
      }}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[open=true]:opacity-100',
        className,
      )}
    >
      <MoreHorizontal className="size-4" />
    </button>
  );
}

const ITEM_ICON = 'mr-2 size-3.5 text-muted-foreground';

/**
 * The one menu of the rail, wherever it was opened: a bot, a team heading, or
 * the empty space. Anchored on an invisible point carried to <body>, so a
 * right click opens it under the pointer even inside an island, whose
 * `contain` would otherwise place a fixed element against the island.
 * `modal={false}`: a plugin entry may open a dialog, and a modal menu handing
 * the pointer lock over to it left the page unclickable (TIM-0010).
 */
function RailMenuView({ menu, teams, onClose, onMove, onEditTeam, onNewBot, onNewTeam, onChanged }: {
  menu: RailMenu;
  teams: Team[];
  onClose: () => void;
  onMove: (bot: Bot, teamId: string | null) => void;
  onEditTeam: (team: Team | null) => void;
  onNewBot: () => void;
  onNewTeam: () => void;
  onChanged: () => Promise<void>;
}) {
  // The bot menu has two pages: its actions, and the teams to move it to.
  const [page, setPage] = useState<'root' | 'teams'>('root');
  const pluginEntries = useSlotEntries(AGENT_MENU_SLOT).length > 0;
  const anchor = (
    <DropdownMenuTrigger asChild>
      <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
    </DropdownMenuTrigger>
  );
  let body: React.ReactNode;
  if (menu.kind === 'bot' && page === 'teams') {
    const { bot } = menu;
    body = (
      <>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPage('root'); }}>
          <ChevronLeft className={ITEM_ICON} />
          {t('bots.back')}
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{t('bots.moveToTeam')}</DropdownMenuLabel>
        {teams.map((team) => (
          <DropdownMenuItem key={team.id} disabled={team.id === bot.team} onSelect={() => onMove(bot, team.id)}>
            <span className="min-w-0 flex-1 truncate">{team.name}</span>
            {team.id === bot.team && <Check className="ml-2 size-3.5" />}
          </DropdownMenuItem>
        ))}
      </>
    );
  } else if (menu.kind === 'bot') {
    const { bot, pinned } = menu;
    const canMove = !pinned && teams.length > 0;
    const canLeave = !pinned && !!bot.team;
    body = (
      <>
        {canMove && (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPage('teams'); }}>
            <UsersRound className={ITEM_ICON} />
            <span className="flex-1">{t('bots.moveToTeam')}</span>
            <ChevronRight className="ml-2 size-3.5 text-muted-foreground" />
          </DropdownMenuItem>
        )}
        {canLeave && (
          <DropdownMenuItem onSelect={() => onMove(bot, null)}>
            <UserMinus className={ITEM_ICON} />
            {t('bots.leaveTeam')}
          </DropdownMenuItem>
        )}
        {(canMove || canLeave) && pluginEntries && <div aria-hidden className="h-1.5" />}
        <AgentMenuSlot agent={{ name: bot.name, role: bot.role ?? null }} />
        {!pinned && !canMove && !canLeave && !pluginEntries && (
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{t('bots.noTeamYet')}</DropdownMenuLabel>
        )}
      </>
    );
  } else {
    body = null;
  }
  return (
    <DropdownMenu modal={false} open onOpenChange={(open) => { if (!open) onClose(); }}>
      {typeof document === 'undefined' ? anchor : createPortal(anchor, document.body)}
      <DropdownMenuContent
        align={menu.align}
        sideOffset={4}
        className="w-56"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {body}
        {menu.kind === 'team' && <TeamItems team={menu.team} onEditTeam={onEditTeam} onChanged={onChanged} />}
        {menu.kind === 'blank' && <BlankItems onNewBot={onNewBot} onNewTeam={onNewTeam} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A team's menu: rename (the team dialog), delete. */
function TeamItems({ team, onEditTeam, onChanged }: {
  team: Team;
  onEditTeam: (team: Team | null) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onEditTeam(team)}>
        <Pencil className={ITEM_ICON} />
        {t('bots.renameTeam')}
      </DropdownMenuItem>
      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { void removeTeam(team, onChanged); }}>
        <Trash2 className="mr-2 size-3.5" />
        {t('bots.deleteTeam')}
      </DropdownMenuItem>
    </>
  );
}

/** The menu of the rail's empty space: what its foot bar does. */
function BlankItems({ onNewBot, onNewTeam }: { onNewBot: () => void; onNewTeam: () => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewBot}>
        <Plus className={ITEM_ICON} />
        {t('bots.newBot')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onNewTeam}>
        <UsersRound className={ITEM_ICON} />
        {t('bots.newTeam')}
      </DropdownMenuItem>
    </>
  );
}

function BotFace({ bot, state, size }: { bot: Bot; state: ActiveState | undefined; size: 'lg' | 'xl' }) {
  const identity = agentIdentity(bot, null);
  return state
    ? <ActiveAgentAvatar identity={identity} state={state} size={size} />
    : <AgentAvatar identity={identity} size={size} roleBadge={false} />;
}

/** The main agent, on top and centred: the one the user talks to first. */
function MainBot({ bot, selected, state, menuOpen, onSelect, onMenu }: {
  bot: Bot;
  selected: boolean;
  state: ActiveState | undefined;
  /** Null when its menu would be empty: no "…", and a right click opens the rail's own. */
  menuOpen: boolean | null;
  onSelect: (name: string) => void;
  onMenu: (place: MenuPlace) => void;
}) {
  return (
    <div
      className={cn(
        'group relative mx-2 rounded-2xl transition-colors hover:bg-muted/40',
        selected && 'bg-muted/70 hover:bg-muted/70',
      )}
      onContextMenu={menuOpen === null ? undefined : (e) => { claim(e); onMenu(atPointer(e)); }}
    >
      <button
        type="button"
        onClick={() => onSelect(bot.name)}
        className="flex w-full flex-col items-center gap-2.5 rounded-2xl px-3 pb-4 pt-5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BotFace bot={bot} state={state} size="xl" />
        <span className="min-w-0 max-w-full">
          <span className="block truncate text-[14px] font-semibold text-foreground">{bot.name}</span>
          {bot.role && <span className="block truncate text-[11px] text-muted-foreground">{bot.role}</span>}
        </span>
      </button>
      {menuOpen !== null && (
        <MoreButton label={t('bots.botMenu', { name: bot.name })} open={menuOpen} onOpen={onMenu} className="absolute right-2 top-2" />
      )}
    </div>
  );
}

function BotRow({ bot, selected, state, menuOpen, draggable, onSelect, onMenu, onDragState }: {
  bot: Bot;
  selected: boolean;
  state: ActiveState | undefined;
  menuOpen: boolean;
  /** Teams exist: the row can be dropped on one. */
  draggable: boolean;
  onSelect: (name: string) => void;
  onMenu: (place: MenuPlace) => void;
  onDragState: (dragging: boolean) => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.setData(BOT_DRAG_TYPE, bot.name);
        e.dataTransfer.effectAllowed = 'move';
        onDragState(true);
      } : undefined}
      onDragEnd={draggable ? () => onDragState(false) : undefined}
      className={cn(
        'group mx-2 flex items-center gap-1 rounded-xl pr-1.5 transition-colors hover:bg-muted/40',
        selected && 'bg-muted/70 hover:bg-muted/70',
      )}
      onContextMenu={(e) => { claim(e); onMenu(atPointer(e)); }}
    >
      <button
        type="button"
        onClick={() => onSelect(bot.name)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1.5 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BotFace bot={bot} state={state} size="lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{bot.name}</span>
          {bot.role && <span className="block truncate text-[11px] text-muted-foreground">{bot.role}</span>}
        </span>
      </button>
      <MoreButton label={t('bots.botMenu', { name: bot.name })} open={menuOpen} onOpen={onMenu} />
    </div>
  );
}

/** A team's heading; its "…" or a right click opens the team's menu. */
function TeamHeading({ team, menuOpen, onMenu }: {
  team: Team;
  menuOpen: boolean;
  onMenu: (place: MenuPlace) => void;
}) {
  return (
    <div
      className="group flex items-center gap-1 pb-1 pl-4 pr-3.5 pt-4"
      onContextMenu={(e) => { claim(e); onMenu(atPointer(e)); }}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">{team.name}</span>
      <MoreButton label={t('bots.teamMenu', { team: team.name })} open={menuOpen} onOpen={onMenu} className="size-6" />
    </div>
  );
}

export function BotsRail({
  bots, teams, selected, states, onSelect, onChanged, headerActions,
}: {
  bots: Bot[];
  teams: Team[];
  selected: string | null;
  states: Map<string, ActiveState>;
  onSelect: (name: string) => void;
  /** Re-reads bots and teams after a write: a move changes the bot's own
   *  config, a deletion frees its members. */
  onChanged: () => Promise<void>;
  /** The drag handle of the widget host, when the rail sits in a widget zone. */
  headerActions?: React.ReactNode;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<TeamEditing | null>(null);
  const [menu, setMenu] = useState<RailMenu | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const pluginEntries = useSlotEntries(AGENT_MENU_SLOT).length > 0;
  const groups = visibleGroups(groupBots(bots, teams), query);
  const mainName = mainBotOf(bots);
  const main = bots.find((bot) => bot.name === mainName && botMatches(bot, query)) ?? null;
  // The team-less heading only means something next to teams.
  const namedTeams = teams.length > 0;
  const nothing = !main && groups.length === 0;

  const isOpen = (kind: RailMenu['kind'], id: string): boolean =>
    menu !== null && menu.kind === kind && (menu.kind === 'bot' ? menu.bot.name : menu.kind === 'team' ? menu.team.id : '') === id;

  async function move(bot: Bot, teamId: string | null): Promise<void> {
    if ((bot.team ?? null) === teamId) return;
    const error = teamId === null
      ? (bot.team ? await removeMember(bot.team, bot.name) : null)
      : await addMember(teamId, bot.name);
    if (error) { toast.error(error); return; }
    await onChanged();
  }

  function newBot(): void {
    openAgentEditor({ isNew: true });
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onContextMenu={(e) => {
        // The search keeps the browser's own menu: paste, spelling.
        if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
        claim(e);
        setMenu({ kind: 'blank', ...atPointer(e) });
      }}
    >
      {headerActions && <div className="flex justify-end px-2 pt-1.5">{headerActions}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2">
        {main && (
          <MainBot
            bot={main}
            selected={selected === main.name}
            state={states.get(main.name)}
            menuOpen={pluginEntries ? isOpen('bot', main.name) : null}
            onSelect={onSelect}
            onMenu={(place) => setMenu({ kind: 'bot', bot: main, pinned: true, ...place })}
          />
        )}
        {groups.map((group) => {
          const target = group.team?.id ?? null;
          return (
            <section
              key={group.key}
              aria-label={group.team ? group.team.name : t('bots.noTeam')}
              data-drop-target={dropOn === group.key || undefined}
              className={cn('rounded-xl pb-1 transition-colors', dragging && dropOn === group.key && 'bg-muted/60')}
              onDragOver={namedTeams ? (e) => {
                if (!e.dataTransfer.types.includes(BOT_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropOn !== group.key) setDropOn(group.key);
              } : undefined}
              onDragLeave={namedTeams ? (e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((key) => (key === group.key ? null : key));
              } : undefined}
              onDrop={namedTeams ? (e) => {
                const name = e.dataTransfer.getData(BOT_DRAG_TYPE);
                if (!name) return;
                e.preventDefault();
                setDropOn(null);
                setDragging(false);
                const bot = bots.find((b) => b.name === name);
                if (bot) void move(bot, target);
              } : undefined}
            >
              {group.team ? (
                <TeamHeading
                  team={group.team}
                  menuOpen={isOpen('team', group.team.id)}
                  onMenu={(place) => setMenu({ kind: 'team', team: group.team!, ...place })}
                />
              ) : namedTeams ? (
                <div className="pb-1 pl-4 pr-4 pt-4 text-[11px] font-medium text-muted-foreground">{t('bots.noTeam')}</div>
              ) : (
                <div aria-hidden className="h-3" />
              )}
              {group.team && group.bots.length === 0 && (
                <p className="px-4 pb-1 text-[11px] text-muted-foreground/70">{t('bots.teamEmpty')}</p>
              )}
              <div className="flex flex-col gap-0.5">
                {group.bots.map((bot) => (
                  <BotRow
                    key={bot.name}
                    bot={bot}
                    selected={selected === bot.name}
                    state={states.get(bot.name)}
                    menuOpen={isOpen('bot', bot.name)}
                    draggable={namedTeams}
                    onSelect={onSelect}
                    onMenu={(place) => setMenu({ kind: 'bot', bot, pinned: false, ...place })}
                    onDragState={(on) => { setDragging(on); if (!on) setDropOn(null); }}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {nothing && query.trim().length > 0 && (
          <p className="px-4 pt-6 text-center text-[12px] text-muted-foreground">{t('bots.noMatch')}</p>
        )}
      </div>
      {menu && (
        <RailMenuView
          key={`${menu.kind}:${menu.x}:${menu.y}`}
          menu={menu}
          teams={[...teams].sort((a, b) => a.name.localeCompare(b.name))}
          onClose={() => setMenu(null)}
          onMove={(bot, teamId) => { void move(bot, teamId); }}
          onEditTeam={(team) => setEditing({ team })}
          onNewBot={newBot}
          onNewTeam={() => setEditing({ team: null })}
          onChanged={onChanged}
        />
      )}
      <TooltipProvider delayDuration={300}>
      <div className="p-2">
        <div className="flex items-center gap-0.5 rounded-xl bg-muted/50 p-1">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 pr-1 focus-within:bg-background">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
              placeholder={t('bots.search')}
              aria-label={t('bots.search')}
              className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <RailTip label={t('bots.clearSearch')}>
                <button type="button" aria-label={t('bots.clearSearch')} onClick={() => setQuery('')} className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground">
                  <X className="size-3" />
                </button>
              </RailTip>
            )}
          </label>
          <RailTip label={t('bots.newBot')}>
            <Link
              prefetch={false}
              href="/edit?new=1"
              aria-label={t('bots.newBot')}
              onClick={(e) => {
                e.preventDefault();
                newBot();
              }}
              className={ICON_BUTTON}
            >
              <Plus className="size-4" />
            </Link>
          </RailTip>
          <RailTip label={t('bots.newTeam')}>
            <button
              type="button"
              aria-label={t('bots.newTeam')}
              onClick={() => setEditing({ team: null })}
              className={ICON_BUTTON}
            >
              <UsersRound className="size-4" />
            </button>
          </RailTip>
          {/* Plugins' icon buttons (agent import…): empty, nothing painted. */}
          <SlotRegion name="bots.rail.action" className="flex items-center gap-0.5 empty:hidden" />
        </div>
      </div>
      </TooltipProvider>
      <TeamDialog open={editing !== null} editing={editing} onClose={() => setEditing(null)} onChanged={onChanged} />
    </div>
  );
}

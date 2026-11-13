'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { Check, ChevronRight, Compass, Focus, LayoutGrid, MessageSquare, Palette, Settings2 } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import { ChatAppearanceItems, useChatAppearanceControls } from '@/components/chat/chat-appearance-menu';
import { GUIDED_TOUR_ENABLED, startOnboardingTour } from '@/lib/guided-tour';
import { GLASS_TUNING_ENABLED } from '@/lib/glass-scope';
import { t } from '@/lib/i18n';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { NativeViewCover } from '@/lib/native-view-cover';

// Painted inside the open menu only: fetched then (docs/BUNDLE-SIZE.md).
const LayoutPresetsSection = dynamic(() => import('@/components/layout-presets-menu').then((m) => m.LayoutPresetsSection), { ssr: false });
const GlassProfilesMenuSection = dynamic(() => import('@/components/glass-profiles').then((m) => m.GlassProfilesMenuSection), { ssr: false });
const IslandArrangementsSection = dynamic(() => import('@/components/island-arrangements-menu').then((m) => m.IslandArrangementsSection), { ssr: false });

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/** Appearance controls share one place in every topbar. Widgets move and
 * resize at any time: there is no layout editing mode to switch on here. */
export function ThemeToggle() {
  const { open: openSettings } = useSettingsNavigation();
  const { paletteOpen, setPaletteOpen, palette } = useWidgetHost();
  // Focus mode only slides the chat's columns away: offering it on a page
  // that has none would be a switch that does nothing.
  const pathname = usePathname();
  const { appearance, toggle } = useChatAppearanceControls();
  const inChat = pathname === '/chat' || pathname === '/multichat';
  // Set by "Add widget": the closing menu must not take focus back to its
  // trigger, the catalog's search field has it.
  const toPalette = useRef(false);

  // Non-modal: "Appearance settings" opens the Settings dialog. A modal menu
  // still closing while it mounts leaves `pointer-events: none` on <body>,
  // and the page stops answering (TIM-0035, TIM-0010).
  return <Dropdown.Root modal={false}>
    <Dropdown.Trigger asChild>
      <Button variant="ghost" size="icon" aria-label={t('appearance.menu.title')} title={t('appearance.menu.title')} className={paletteOpen ? 'relative text-primary' : 'text-muted-foreground hover:text-foreground'}>
        <Palette className="size-4" />
        {paletteOpen && <span className="absolute bottom-1.5 right-1.5 size-1.5 rounded-full bg-primary" />}
      </Button>
    </Dropdown.Trigger>
    <Dropdown.Portal>
      <Dropdown.Content align="end" sideOffset={8} onCloseAutoFocus={(e) => { if (toPalette.current) { e.preventDefault(); toPalette.current = false; } }} className="z-50 w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-2">
        <NativeViewCover />
        <Dropdown.Label className="px-3 py-2 text-xs font-medium">{t('appearance.menu.title')}</Dropdown.Label>
        <Dropdown.Item className={ITEM} onSelect={() => openSettings({ category: 'interface', tab: 'appearance' })}>
          <Settings2 className="size-4" /><span className="flex-1">{t('appearance.title')}</span>
        </Dropdown.Item>
        {/* Opens the catalog in the middle of the screen. */}
        <Dropdown.Item disabled={palette.length === 0} className={ITEM} onSelect={() => { toPalette.current = true; setPaletteOpen(true); }}>
          <LayoutGrid className="size-4" /><span className="flex-1">{t('appearance.menu.addWidget')}</span>
          <span className="text-[10.5px] tabular-nums text-muted-foreground">{palette.length}</span>
        </Dropdown.Item>
        {inChat && (
          <Dropdown.Sub>
            <Dropdown.SubTrigger className={ITEM}>
              <MessageSquare className="size-4" /><span className="flex-1">{t('chatPage.appearance.title')}</span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </Dropdown.SubTrigger>
            <Dropdown.Portal>
              <Dropdown.SubContent sideOffset={6} className="z-50 min-w-[15rem] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-2">
                <ChatAppearanceItems />
              </Dropdown.SubContent>
            </Dropdown.Portal>
          </Dropdown.Sub>
        )}
        {inChat && (
          <Dropdown.CheckboxItem checked={appearance.focusMode} onCheckedChange={() => toggle('focusMode')} className={ITEM}>
            <Focus className="size-4" /><span className="flex-1">{t('appearance.menu.focusMode')}</span>
            <Dropdown.ItemIndicator><Check className="size-3.5" /></Dropdown.ItemIndicator>
          </Dropdown.CheckboxItem>
        )}
        {GUIDED_TOUR_ENABLED && (
          <Dropdown.Item className={ITEM} onSelect={() => {
            void startOnboardingTour(t('guidedTour.firstMessage')).then((out) => {
              if (!out.ok) toast.error(t('guidedTour.failed'));
            });
          }}>
            <Compass className="size-4" /><span className="flex-1">{t('guidedTour.menu')}</span>
          </Dropdown.Item>
        )}
        <LayoutPresetsSection />
        {GLASS_TUNING_ENABLED && <GlassProfilesMenuSection />}
        <IslandArrangementsSection />
      </Dropdown.Content>
    </Dropdown.Portal>
  </Dropdown.Root>;
}

'use client';

import { useState, type MouseEvent } from 'react';
import { Camera } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useInstance } from '@/components/instance-provider';
import { FileContextMenu } from '@/components/chat/file-context-menu';
import { ROOKS_MARK } from '@/lib/brand-mark';
import { RELEASE_INSTANCE } from '@/lib/instance';
import { useDevProductLogo } from '@/lib/dev-logo';
import { t } from '@/lib/i18n';

/**
 * The Rooks mark, drawn inline so it takes the colour of the instance: the
 * theme's primary colour for the product, so a theme (the product's or a
 * plugin's) recolours it with everything else; a fixed colour of its own for
 * the development copy, so the maintainer cannot confuse the two windows.
 *
 * In the development copy only, a right-click on the mark switches it to the
 * product's look (and hides the DEV pill) for screenshots, and back.
 *
 * One SVG for light and dark: the colour is a CSS value, resolved by the
 * browser, so the server renders the right thing and nothing swaps after
 * hydration. Outside `InstanceProvider` the context default applies and the
 * product's colour is used.
 */
export function BrandLogo({
  className,
  alt = '',
}: {
  /** Sizing only — a height; the width follows the mark's proportions. */
  className?: string;
  /** Empty by default: next to a text label the logo is decorative. */
  alt?: string;
}) {
  const instance = useInstance();
  const dev = instance.variant === 'dev';
  const [productLogo, setProductLogo] = useDevProductLogo();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const color = dev && productLogo ? RELEASE_INSTANCE.logo.color : instance.logo.color;
  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  return (
    <>
      <svg
        viewBox={ROOKS_MARK.viewBox}
        className={cn('w-auto shrink-0', className)}
        style={{ color, aspectRatio: ROOKS_MARK.ratio }}
        data-brand-logo={dev && productLogo ? 'product' : ''}
        onContextMenu={dev ? openMenu : undefined}
        {...(alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true })}
      >
        <path fill="currentColor" fillRule={ROOKS_MARK.fillRule} clipRule={ROOKS_MARK.fillRule} d={ROOKS_MARK.d} />
      </svg>
      {dev && menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={t('brandLogo.menu')}
          onClose={() => setMenu(null)}
          items={[{
            key: 'product-logo',
            label: productLogo ? t('brandLogo.devLogo') : t('brandLogo.productLogo'),
            icon: <Camera className="size-3.5" aria-hidden />,
            onSelect: () => setProductLogo(!productLogo),
          }]}
        />
      )}
    </>
  );
}

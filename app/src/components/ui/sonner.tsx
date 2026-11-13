"use client"

import { useColorScheme } from "@/components/theme-provider"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

/**
 * The app mounts exactly ONE toaster, on the root layout (see
 * `app/layout.tsx`). Do not add a `<Toaster />` to a page: sonner renders in
 * place, so a page-level toaster lands inside that page's own stacking
 * context (most pages wrap their content in `relative z-[1]`) and its
 * z-index — however large — is capped below the shared topbar (`z-20`). That
 * is the bug that kept coming back, page after page.
 *
 * `offset.top` clears the topbar (logo `h-10` + `py-1.5` + border ≈ 56px) so
 * a toast sits under it rather than on top of it.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { scheme: theme } = useColorScheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-right"
      offset={{ top: 68, right: 16 }}
      mobileOffset={{ top: 68, left: 16, right: 16 }}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }

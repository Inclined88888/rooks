// Pro gating in the UI. Free features are never wrapped. When a Pro feature is locked we show a friendly card,
// never an error, and nothing the user already made is hidden or removed.
import { Lock, X } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { hasFeature, themeLocked, useAccount } from "./account";
import { DEFAULTS, applyTo, useAppearance } from "./appearance";
import { AccountSetup } from "./pages/Plan";
import "./pages/settings/settings.css";
import { Badge, Button, IconButton } from "./ui";

type Upgrade = { feature?: string; label?: string; message?: string };

export function UpgradeCard({ feature, label, message, onClose }: Upgrade & { onClose?: () => void }) {
  const navigate = useNavigate();
  const [account] = useAccount();
  const go = () => { onClose?.(); navigate(`/plan${feature ? `?feature=${encodeURIComponent(feature)}` : ""}`); };
  return (
    <section className="st-upgrade" aria-label="Upgrade to Pro">
      <div className="st-upgrade-head">
        <Badge>Pro</Badge>
        <span className="st-grow" />
        {onClose && <IconButton size="sm" label="Close" onClick={onClose}><X size={16} /></IconButton>}
      </div>
      <div className="st-stack">
        <h2 className="st-upgrade-title">{label ?? "This"} is part of Pro</h2>
        <p className="st-small">
          {message ?? "Upgrade to unlock it."} Everything you already made stays right where it is, and the free app keeps working.
        </p>
      </div>
      <div className="st-form-actions">
        <Button variant="primary" icon={<Lock size={14} />} onClick={go}>{account?.signed_in ? "See plans" : "Sign in or upgrade"}</Button>
        {onClose && <Button variant="ghost" onClick={onClose}>Not now</Button>}
      </div>
    </section>
  );
}

/** Wrap a Pro-only screen. While billing is not live, or the account is still loading, the children show. */
export function ProGate({ feature, label, children }: { feature: string; label?: string; children: ReactNode }) {
  const [account] = useAccount();
  if (hasFeature(account, feature)) return <>{children}</>;
  const f = account?.pro_features.find((p) => p.id === feature);
  return <UpgradeCard feature={feature} label={label ?? f?.label} />;
}

/** One app-wide listener: any API call answered with 402 upgrade_required shows the upgrade card. */
export function UpgradePrompt() {
  const [up, setUp] = useState<Upgrade | null>(null);
  useEffect(() => {
    const on = (e: Event) => setUp((e as CustomEvent<Upgrade>).detail ?? {});
    window.addEventListener("wb:upgrade", on);
    return () => window.removeEventListener("wb:upgrade", on);
  }, []);
  if (!up) return null;
  return (
    <div className="st-modal" onClick={() => setUp(null)} role="dialog" aria-modal="true" aria-label="Upgrade to Pro">
      <div onClick={(e) => e.stopPropagation()} className="st-modal-body">
        <UpgradeCard {...up} onClose={() => setUp(null)} />
      </div>
    </div>
  );
}

/** Mounted once inside the signed-in app: the optional sign-in step after first-run setup, the upgrade card, and
 * premium themes falling back to the default look (the saved choice is kept and comes back on upgrade). */
export function AccountLayer() {
  const [account] = useAccount();
  const [appearance] = useAppearance();
  const [stepDone, setStepDone] = useState(false);
  useEffect(() => {
    if (themeLocked(account, appearance.theme, DEFAULTS.theme)) applyTo(document.documentElement, { ...appearance, theme: DEFAULTS.theme });
  }, [account, appearance]);
  return (
    <>
      <UpgradePrompt />
      {account?.setup_prompt && !stepDone && (
        <div className="st-cover">
          <AccountSetup onDone={() => setStepDone(true)} />
        </div>
      )}
    </>
  );
}

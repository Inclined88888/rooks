import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, ErrorState, Input, Loading } from "../ui";
import { useToast } from "../util";
import { Advanced, Notice, SettingRow, SettingsGroup, Switch } from "./settings";

type Lan = { available: boolean; enabled: boolean; running: boolean; port: number; addresses: string[]; error: string };
type Pairing = { code: string; expires_in: number; urls: string[]; qr: string; qr_svg: string; lan: Lan; relay_url: string };
type Device = { id: number; name: string; platform: string; created_at: string; last_seen: string | null; push: number };
type MobileSettings = { lan: Lan; relay_url: string; push_enabled: boolean };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "not yet");

function statusLine(cfg: MobileSettings, devices: Device[]): string {
  const home = cfg.lan.running;
  const away = !!cfg.relay_url;
  if (!devices.length) {
    if (home) return "Pair a phone on this Wi-Fi. The work stays on this computer.";
    if (away) return "A phone can reach this computer from anywhere. The work stays here.";
    if (cfg.lan.available) return "Pair a phone on this Wi-Fi. The work stays on this computer.";
    return "Open Rooks on this computer to pair a phone on the same Wi-Fi.";
  }
  if (home && away) return "Reachable on this Wi-Fi, and from anywhere.";
  if (home) return "Reachable on this Wi-Fi.";
  if (away) return "Reachable from anywhere.";
  if (cfg.lan.available) return "Paired. Allow this Wi-Fi so the phone can reach this computer.";
  return "Paired. Open Rooks on this computer so the phone can reach it on your Wi-Fi.";
}

/** Settings → Phone: pair by a code, then a status line. Addresses stay under Advanced. */
export function PhoneCard() {
  const toast = useToast();
  const [pair, setPair] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [cfg, setCfg] = useState<MobileSettings | null>(null);
  const [relay, setRelay] = useState("");
  const [blocked, setBlocked] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setDevices(await api<Device[]>("/mobile/devices"));
    const s = await api<MobileSettings>("/mobile/settings");
    setCfg(s);
    setRelay(s.relay_url);
  }, []);
  const retry = useCallback(() => { setFailed(false); load().catch(() => setFailed(true)); }, [load]);
  useEffect(() => { retry(); }, [retry]);

  useEffect(() => {
    if (!pair) return;
    const end = Date.now() + pair.expires_in * 1000;
    const t = window.setInterval(() => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setPair(null);
      if (s % 3 === 0) api<Device[]>("/mobile/devices").then((d) => {
        setDevices((prev) => {
          if (d.length > prev.length) { setPair(null); toast.ok(`${d[0].name} is paired`); }
          return d;
        });
      }).catch(() => undefined);
    }, 1000);
    setLeft(pair.expires_in);
    return () => window.clearInterval(t);
  }, [pair]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body: Partial<{ lan_enabled: boolean; relay_url: string; push_enabled: boolean }>, quiet = false) => {
    const s = await api<MobileSettings>("/mobile/settings", { method: "PUT", body });
    setCfg(s);
    setRelay(s.relay_url);
    if (!quiet) toast.ok("Saved");
    return s;
  };

  const start = async () => {
    setBlocked("");
    try {
      let settings = cfg;
      if (settings?.lan.available && !settings.lan.enabled) settings = await save({ lan_enabled: true }, true);
      if (!settings?.lan.running && !settings?.relay_url) {
        setBlocked(settings?.lan.available
          ? "The Wi-Fi connection didn't start. Try again in a moment."
          : "This page is only on this computer. Open Rooks on this computer, then pair the phone from there.");
        return;
      }
      const next = await api<Pairing>("/mobile/pair/start", { method: "POST" });
      if (!next.urls.length) {
        setBlocked("This computer has no address a phone can use yet.");
        return;
      }
      setPair(next);
    } catch (e) { toast.err(e); }
  };

  const revoke = async (d: Device) => {
    try { await api(`/mobile/devices/${d.id}`, { method: "DELETE" }); toast.ok(`${d.name} can no longer reach this workspace`); load(); }
    catch (e) { toast.err(e); }
  };

  if (failed && !cfg) return <ErrorState title="Phone settings did not load" line="The app did not answer. Try again in a moment." onRetry={retry} />;
  if (!cfg) return <Loading rows={2} label="Loading phone settings" />;

  return (
    <div className="st-stack" id="phone">
      <SettingsGroup>
        <SettingRow label="Pair a phone" help={statusLine(cfg, devices)}>
          {!pair && <Button variant="primary" size="sm" onClick={start}>Pair a phone</Button>}
        </SettingRow>
        {blocked && <div className="st-row"><Notice>{blocked}</Notice></div>}
        {pair && (
          <div className="st-row">
            <div className="st-pair">
              <div className="st-qr" dangerouslySetInnerHTML={{ __html: pair.qr_svg }} role="img" aria-label="Pairing code to scan" />
              <div className="st-stack st-grow">
                <span className="st-pair-code">{pair.code}</span>
                <p className="st-small">
                  Open Rooks on the phone and scan this. The phone should be on this Wi-Fi.
                  {pair.relay_url ? " It can also reach this computer from somewhere else." : ""}
                  {" "}Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
                </p>
                <div><Button variant="ghost" size="sm" onClick={() => setPair(null)}>Cancel</Button></div>
              </div>
            </div>
          </div>
        )}
        {devices.map((d) => (
          <div key={d.id} className="st-item">
            <div className="st-item-text">
              <span className="st-item-title">{d.name} <span className="st-item-meta">{d.platform || "phone"}{d.push ? " · notifications on" : ""}</span></span>
              <span className="st-item-meta">Paired {when(d.created_at)} · last seen {when(d.last_seen)}</span>
            </div>
            <span className="st-item-actions"><Button variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={() => revoke(d)}>Unpair</Button></span>
          </div>
        ))}
        {devices.length > 0 && (
          <SettingRow label="Notifications" help="Tell this phone when something needs you.">
            <Switch checked={cfg.push_enabled} onChange={(on) => { save({ push_enabled: on }).catch(toast.err); }} label="Tell this phone when something needs you" />
          </SettingRow>
        )}
        <div className="st-row">
          <Advanced>
            {cfg.lan.available && (
              <SettingRow label="Allow a phone on this Wi-Fi" help={cfg.lan.running ? "On" : cfg.lan.error ? "Didn't start" : "Off"}>
                <Switch checked={cfg.lan.enabled} onChange={(on) => { save({ lan_enabled: on }).catch(toast.err); }} label="Allow a phone on this Wi-Fi" />
              </SettingRow>
            )}
            <div className="st-stack">
              <span className="st-row-label">Private address</span>
              <span className="st-small">Only if you already have one the phone can open.</span>
              <div className="st-key">
                <Input value={relay} placeholder="https://" onChange={(e) => setRelay(e.target.value)} aria-label="Private address" />
                <Button disabled={relay === cfg.relay_url} onClick={() => { save({ relay_url: relay }).catch(toast.err); }}>Save</Button>
              </div>
            </div>
          </Advanced>
        </div>
      </SettingsGroup>
    </div>
  );
}

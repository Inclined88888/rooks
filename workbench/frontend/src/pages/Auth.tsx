import { Lock } from "lucide-react";
import { FormEvent, useState } from "react";
import { api, saveBrowserToken } from "../api";
import type { Status } from "../App";
import { PRODUCT } from "../product";
import { Button, Input } from "../ui";
import { Advanced, AuthCard, Notice } from "./settings/index";

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { body: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="st-auth-form" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="PIN or password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy} disabled={!password}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="st-auth-alt">
        <PairCode busy={busy} onDone={onDone} onError={setError} />
        <Button variant="ghost" disabled={busy} onClick={async () => {
          if (!window.confirm("The old PIN can't be looked up. Set a new one? Your mail, notes and tasks stay.")) return;
          setBusy(true);
          setError("");
          try { await api("/lock/reset", { method: "POST" }); onDone(); }
          catch (err) { setError((err as Error).message); setBusy(false); }
        }}>Forgot it? Set a new one</Button>
      </div>
    </>
  );
}

function PairCode({ busy, onDone, onError }: { busy: boolean; onDone: () => void; onError: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  if (!open) return <Button variant="ghost" disabled={busy} onClick={() => setOpen(true)}>I have a pairing code</Button>;
  const connect = async () => {
    setWorking(true);
    try {
      const r = await api<{ token: string }>("/browser/pair/claim", { body: { code } });
      saveBrowserToken(r.token);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="st-auth-form">
      <Input label="Pairing code" hint="Made in Settings, Tools, on the computer Rooks runs on." value={code} autoComplete="one-time-code" placeholder="ABCD-EFGH" onChange={(e) => setCode(e.target.value)} />
      <Button busy={working} disabled={code.trim().length < 8} onClick={connect}>{working ? "Checking…" : "Connect this browser"}</Button>
    </div>
  );
}

/** A server install opens with a one-time link (setup prints the first; Settings or the server make more). */
function LinkCard({ status, onDone }: { status: Status; onDone: () => void }) {
  const [error, setError] = useState("");
  const [pin, setPin] = useState(false);
  const spent = window.location.search.includes("signin=expired");  // the server sends a bad or used link here
  if (pin) {
    return (
      <AuthCard title="Welcome back" line={`Use the PIN you created for ${PRODUCT}.`}>
        <Login onDone={onDone} />
        <Button variant="ghost" onClick={() => setPin(false)}>Use a sign-in link instead</Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Open your sign-in link"
      line={status.setup_complete
        ? `${PRODUCT} opens with a link instead of a password. Open one made in Settings on a device that is already signed in.`
        : `${PRODUCT} opens with a link instead of a password. Use the link shown when it was installed.`}
      footer={<><Lock size={12} aria-hidden="true" /> Only someone with a link can open it.</>}>
      {spent && <Notice tone="danger">That link was already used or has expired. Make a new one.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-auth-alt">
        <PairCode busy={false} onDone={onDone} onError={setError} />
        {status.pin_login && <Button variant="ghost" onClick={() => setPin(true)}>Use my PIN</Button>}
      </div>
      <Advanced label="Make a new link on the server">
        <p className="st-small">On the computer {PRODUCT} runs on, in its folder:</p>
        <code className="st-mono st-small">docker compose exec workbench python -m app.signin</code>
      </Advanced>
    </AuthCard>
  );
}

export default function Auth({ status, onDone }: { status: Status; onDone: () => void }) {
  return <LinkCard status={status} onDone={onDone} />;
}

/**
 * Settings → Ask from anywhere & voice (feat/v02-anywhere-voice): the shortcut, what the ask bar picks up, how I listen
 * and how I speak. Plain choices with the best one picked for you.
 */
import { Keyboard, RotateCcw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, ErrorState, Input, Loading, Page, Section, Select } from "../ui";
import { errorText } from "../ui/toast";
import { inDesktopShell, invoke } from "../desktop";
import { useToast } from "../util";
import { DictateButton } from "../voice/DictateButton";
import { isMac, speak, systemVoices, voiceStatus, VoiceStatus } from "../voice/engine";
import { accelFromEvent, accelLabel } from "../voice/logic";
import "../voice/voice.css";
import { Advanced, ButtonLink, Notice, SettingRow, SettingsGroup, Switch } from "./settings";

type AnySettings = { grab_selection: boolean; screenshot: boolean; shortcut: string; desk: boolean; desktop: boolean; tier: string };
type ShortcutInfo = { shortcut: string; default: string; enabled: boolean; registered: boolean };

export function PlanBadge({ tier }: { tier?: string }) {
  return <Badge>{tier === "pro" ? "Pro" : "Free"}</Badge>;
}

function ShortcutRecorder({ info, onSave }: { info: ShortcutInfo; onSave: (accel: string, enabled: boolean) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const mac = isMac();
  return (
    <span className="st-inline">
      <button type="button" className={`st-shortcut${recording ? " is-recording" : ""}`} aria-label={recording ? "Press the new shortcut" : `Shortcut: ${accelLabel(info.shortcut, mac)}. Click to change`}
        onClick={() => setRecording(true)} onBlur={() => setRecording(false)}
        onKeyDown={async (e) => {
          if (!recording) return;
          e.preventDefault();
          if (e.key === "Escape") return setRecording(false);
          const accel = accelFromEvent(e.nativeEvent);
          if (accel) { setRecording(false); await onSave(accel, true); }
        }}>
        <Keyboard size={14} /> {recording ? "Press the keys…" : accelLabel(info.shortcut, mac)}
      </button>
      {info.shortcut !== info.default && <Button variant="ghost" size="sm" icon={<RotateCcw size={13} />} onClick={() => onSave(info.default, true)}>Back to {accelLabel(info.default, mac)}</Button>}
      <Switch checked={info.enabled} onChange={(on) => onSave(info.shortcut, on)} label="Shortcut on" />
    </span>
  );
}

const LANGS = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["ja", "Japanese"], ["zh", "Chinese"], ["hi", "Hindi"], ["ar", "Arabic"]];

export default function VoiceSettings() {
  const [any, setAny] = useState<AnySettings | null>(null);
  const [sc, setSc] = useState<ShortcutInfo | null>(null);
  const [st, setSt] = useState<VoiceStatus | null>(null);
  const [failed, setFailed] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [heard, setHeard] = useState("");
  const toast = useToast();
  const desktop = inDesktopShell();

  const load = useCallback(() => {
    setFailed("");
    api<AnySettings>("/anywhere/settings").then(setAny).catch((e) => setFailed(errorText(e)));
    voiceStatus().then(setSt).catch((e) => setFailed(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    if (desktop) invoke<ShortcutInfo>("get_ask_shortcut").then(setSc).catch(() => undefined);
    const loadVoices = () => setVoices(systemVoices());
    loadVoices();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.onvoiceschanged = loadVoices;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveShortcut = async (shortcut: string, enabled: boolean) => {
    try {
      const r = await invoke<ShortcutInfo>("set_ask_shortcut", { shortcut, enabled });
      setSc(r);
      await api("/anywhere/settings", { method: "PUT", body: { shortcut } });
      toast.ok(enabled ? `Shortcut set to ${accelLabel(shortcut, isMac())}` : "Shortcut off");
    } catch (e) { toast.err(e); }
  };
  const putAny = async (body: Partial<AnySettings>) => {
    try { setAny(await api<AnySettings>("/anywhere/settings", { method: "PUT", body })); } catch (e) { toast.err(e); }
  };
  const putVoice = async (body: Record<string, string>) => {
    try { setSt(await api<VoiceStatus>("/voice/settings", { method: "PUT", body })); } catch (e) { toast.err(e); }
  };

  const s = st?.settings;
  const lang = navigator.language?.split("-")[0];
  const shownVoices = voices.filter((v) => !s?.language || v.lang.toLowerCase().startsWith(s.language.toLowerCase()) || v.lang.startsWith(lang ?? ""));
  const waiting = failed && (!any || !st) ? <ErrorState title="These settings did not load" line={failed} onRetry={load} /> : <Loading rows={3} label="Loading voice settings" />;

  return (
    <Page title="Ask from anywhere and voice" description="Ask about whatever you're looking at, in any app, and talk instead of typing." className="st-page">
      <Section title="Ask from anywhere" actions={<PlanBadge tier="free" />}
        description="Select some text in any app and press the shortcut. A small ask bar opens on top with your text in it. Ask about it, or have it rewritten, then paste the answer back.">
        {!any ? waiting : (
          <SettingsGroup>
            <SettingRow label="Shortcut" help={desktop ? (sc && sc.enabled && !sc.registered ? "Another app is using this shortcut. Pick a different one." : "Click the key and press the new keys to change it.")
              : "The shortcut works in the Rooks desktop app for Mac and Windows."}>
              {desktop ? (sc ? <ShortcutRecorder info={sc} onSave={saveShortcut} /> : <span className="st-small" role="status">Loading the shortcut…</span>)
                : <ButtonLink size="sm" to="/ask-bar">Open the ask bar</ButtonLink>}
            </SettingRow>
            <SettingRow label="Bring in the text I have selected" help="It's copied for a moment, then your clipboard is put back.">
              <Switch checked={any.grab_selection} onChange={(on) => putAny({ grab_selection: on })} label="Bring in the text I have selected" />
            </SettingRow>
            <SettingRow label="Include a picture of the window I'm in"
              help={!any.desk ? "Needs Computer use, set up on the Computer page." : any.screenshot ? "Pictures go to the model you've chosen for Chat. Use a model that can see images." : "Lets the assistant see what you see."}>
              <Switch checked={any.screenshot} disabled={!any.desk} onChange={(on) => putAny({ screenshot: on })} label="Include a picture of the window I'm in" />
            </SettingRow>
          </SettingsGroup>
        )}
      </Section>

      <Section title="Listening" actions={<PlanBadge tier="free" />}
        description={st ? `Right now I listen with ${st.engine === "local" ? "Whisper on this computer" : st.engine === "cloud" ? `${st.engines.cloud?.name} (cloud)` : "your browser"}.` : undefined}>
        {!st || !s ? waiting : (
          <SettingsGroup>
            <SettingRow label="Speech to text" help="How your voice becomes text.">
              <Select aria-label="Speech to text" value={s.stt} onChange={(e) => putVoice({ stt: e.target.value })}>
                <option value="auto">Best available (recommended)</option>
                <option value="local" disabled={!st.engines.local}>Only on this computer (private, works offline){st.engines.local ? "" : ": not installed"}</option>
                <option value="cloud" disabled={!st.engines.cloud}>Cloud speech model{st.engines.cloud ? `: ${st.engines.cloud.name}` : ": connect Groq or OpenAI in Models"}</option>
                <option value="browser">The browser's own recognition</option>
              </Select>
            </SettingRow>
            {st.engines.local ? (
              <SettingRow label="Whisper size" help="Bigger is more accurate but slower.">
                <Select aria-label="Whisper size" value={s.local_model} onChange={(e) => putVoice({ local_model: e.target.value })}>
                  {["tiny", "base", "small", "medium", "turbo", "large-v3"].map((m) => <option key={m} value={m}>{m}{m === "base" ? " (recommended)" : ""}</option>)}
                </Select>
              </SettingRow>
            ) : (
              <div className="st-row">
                <Advanced label="Private, offline listening">
                  <p className="st-small">Install Whisper on this computer (the desktop app's installer can add it): <span className="st-mono">pip install faster-whisper</span></p>
                </Advanced>
              </div>
            )}
            <SettingRow label="Language" help="Leave on Detect unless it keeps guessing wrong.">
              <Select aria-label="Language" value={s.language} onChange={(e) => putVoice({ language: e.target.value })}>
                <option value="">Detect automatically</option>
                {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
              </Select>
            </SettingRow>
            <SettingRow label="Try it" help={heard ? `“${heard}”` : "Click the mic and say something."}>
              <DictateButton onText={setHeard} className="ui-btn ui-btn-secondary ui-btn-sm" />
            </SettingRow>
          </SettingsGroup>
        )}
      </Section>

      <Section title="Speaking and hands-free" actions={<PlanBadge tier="pro" />}>
        {!st || !s ? waiting : (
          <div className="st-stack">
            {!st.features.voice_conversation?.allowed && <Notice>Hands-free conversation, the wake word and answering approvals out loud are part of Pro. Dictation stays free.</Notice>}
            <SettingsGroup>
              <SettingRow label="My voice" help="How answers sound when read out.">
                <Select aria-label="My voice" value={s.tts} onChange={(e) => putVoice({ tts: e.target.value })}>
                  <option value="system">Your computer's own voices (free, private)</option>
                  <option value="cloud" disabled={!st.engines.cloud_voice}>A natural cloud voice{st.engines.cloud_voice ? `: ${st.engines.cloud_voice.name}` : ": connect OpenAI in Models"}</option>
                </Select>
              </SettingRow>
              {s.tts === "system" && (
                <SettingRow label="Voice">
                  <Select aria-label="Voice" value={s.name} onChange={(e) => putVoice({ name: e.target.value })}>
                    <option value="">Default</option>
                    {shownVoices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
                  </Select>
                </SettingRow>
              )}
              {s.tts === "cloud" && (
                <SettingRow label="Cloud voice">
                  <Select aria-label="Cloud voice" value={s.cloud_voice} onChange={(e) => putVoice({ cloud_voice: e.target.value })}>
                    {["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"].map((v) => <option key={v}>{v}</option>)}
                  </Select>
                </SettingRow>
              )}
              <SettingRow label="Speed">
                <Select aria-label="Speed" value={s.rate} onChange={(e) => putVoice({ rate: e.target.value })}>
                  {[["0.8", "Slower"], ["1", "Normal"], ["1.2", "Faster"], ["1.5", "Fast"]].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </Select>
              </SettingRow>
              <SettingRow label="Hear it" help="A short sentence in the voice you picked.">
                <Button size="sm" icon={<Volume2 size={14} />} onClick={() => speak("Hi! This is how I'll sound when I answer you.", s)}>Hear it</Button>
              </SettingRow>
              <SettingRow label="Wake word" help={st.wake_ok ? "Say this to start talking hands-free. Only listens on this computer, never in the cloud." : "The wake word needs Whisper on this computer or the browser's own recognition."}>
                <Input aria-label="Wake word" defaultValue={s.wake_phrase} onBlur={(e) => e.target.value.trim() && e.target.value !== s.wake_phrase && putVoice({ wake_phrase: e.target.value })} />
              </SettingRow>
              <SettingRow label="Talk" help="When something needs your OK, like sending an email, I show it on screen and read it out. Only a clear “yes, send it” approves it.">
                <ButtonLink size="sm" variant="primary" to="/talk">Open Talk</ButtonLink>
              </SettingRow>
            </SettingsGroup>
          </div>
        )}
      </Section>
    </Page>
  );
}

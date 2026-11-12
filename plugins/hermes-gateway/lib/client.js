// src/client.tsx
import React from "react";
import * as ui from "@rooks/ui";

// src/messages.json
var messages_default = {
  en: {
    title: "Hermes Gateway",
    intro: "Your Hermes agents, running on your own Hermes gateway, answer in Rooks like any other agent. Each account uses its own gateway and key.",
    connections: "Your gateways",
    empty: "No Hermes gateway yet. Add one in Settings \u203A Secrets \u203A Connections: its address, its API server key (API_SERVER_KEY) and, for a named Hermes profile, the profile name.",
    add: "Add a gateway",
    refresh: "Check again",
    checking: "Checking\u2026",
    create: "Add my Hermes agents to Rooks",
    creating: "Adding\u2026",
    profile: "profile {profile}",
    agents: "Reached in Rooks through: {names}",
    "state.ok": "Connected",
    "state.okVersion": "Connected \u2014 Hermes {version}",
    "state.pending": "Waiting for an administrator to approve this address",
    "state.off": "Turned off",
    "state.error": "Unreachable",
    upgrade: "Hermes {recommended} or later lets an interrupted stream resume where it stopped.",
    "report.created": "Added to Rooks: {names}",
    "report.updated": "Updated in Rooks: {names}",
    "report.kept": "Already in Rooks: {names}",
    "report.skipped": "Name taken by another Rooks agent: {names}",
    "report.none": "Nothing to add: no connected gateway.",
    "error.load": "Could not read your gateways.",
    "error.create": "Your Hermes agents could not be added to Rooks: {message}",
    "note.agents": "Each connected Hermes profile appears in Rooks as an agent (hermes.<profile>); anyone who talks to it reaches their own gateway. When several of your gateways serve the same profile, each gets its own agent (hermes.<connection>.<profile>), which only your account can use. Nothing is created or changed on your gateways.",
    "note.limits": "Hermes agents work on the gateway's machine: no code tasks, no attached files, and no Rooks tools (Kanban, messages, memory)."
  },
  fr: {
    title: "Hermes Gateway",
    intro: "Vos agents Hermes, qui tournent sur votre propre gateway Hermes, r\xE9pondent dans Rooks comme n'importe quel agent. Chaque compte utilise sa gateway et sa cl\xE9.",
    connections: "Vos gateways",
    empty: "Aucune gateway Hermes pour l'instant. Ajoutez-en une dans R\xE9glages \u203A Secrets \u203A Connexions : son adresse, la cl\xE9 de son serveur d'API (API_SERVER_KEY) et, pour un profil Hermes nomm\xE9, le nom du profil.",
    add: "Ajouter une gateway",
    refresh: "V\xE9rifier \xE0 nouveau",
    checking: "V\xE9rification\u2026",
    create: "Ajouter mes agents Hermes \xE0 Rooks",
    creating: "Ajout\u2026",
    profile: "profil {profile}",
    agents: "Accessible dans Rooks par : {names}",
    "state.ok": "Connect\xE9e",
    "state.okVersion": "Connect\xE9e \u2014 Hermes {version}",
    "state.pending": "En attente de l'approbation de cette adresse par un administrateur",
    "state.off": "D\xE9sactiv\xE9e",
    "state.error": "Injoignable",
    upgrade: "Hermes {recommended} ou plus r\xE9cent permet de reprendre un flux interrompu l\xE0 o\xF9 il s'est arr\xEAt\xE9.",
    "report.created": "Ajout\xE9s \xE0 Rooks : {names}",
    "report.updated": "Mis \xE0 jour dans Rooks : {names}",
    "report.kept": "D\xE9j\xE0 dans Rooks : {names}",
    "report.skipped": "Nom d\xE9j\xE0 pris par un autre agent Rooks : {names}",
    "report.none": "Rien \xE0 ajouter : aucune gateway connect\xE9e.",
    "error.load": "Impossible de lire vos gateways.",
    "error.create": "Vos agents Hermes n'ont pas pu \xEAtre ajout\xE9s \xE0 Rooks : {message}",
    "note.agents": "Chaque profil Hermes connect\xE9 appara\xEEt dans Rooks comme un agent (hermes.<profil>) ; quiconque lui parle atteint sa propre gateway. Quand plusieurs de vos gateways servent le m\xEAme profil, chacune a son agent (hermes.<connexion>.<profil>), que seul votre compte peut utiliser. Rien n'est cr\xE9\xE9 ni modifi\xE9 sur vos gateways.",
    "note.limits": "Les agents Hermes travaillent sur la machine de la gateway : pas de tasks de code, pas de fichiers joints, et pas d'outils Rooks (Kanban, messages, m\xE9moire)."
  }
};

// src/client.tsx
var t = ui.createTranslator(messages_default);
var Button2 = ui.Button;
var RECOMMENDED = "0.21.6";
var DOT = {
  ok: "hsl(142 71% 40%)",
  pending: "hsl(38 92% 50%)",
  off: "hsl(var(--muted-foreground))",
  error: "hsl(var(--destructive))"
};
function older(version) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const a = version ? parse(version) : null;
  const b = parse(RECOMMENDED);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
function stateText(c) {
  if (c.state === "ok") return c.version ? t("state.okVersion", { version: c.version }) : t("state.ok");
  if (c.state === "error") return c.message ?? t("state.error");
  return t(`state.${c.state}`);
}
function ConnectionRow({ connection }) {
  return /* @__PURE__ */ React.createElement("li", { className: "flex items-start gap-3 rounded-md bg-muted/40 px-3 py-2" }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { width: 8, height: 8, borderRadius: 9999, marginTop: 6, flexShrink: 0, background: DOT[connection.state] } }), /* @__PURE__ */ React.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" }, /* @__PURE__ */ React.createElement("span", { className: "text-sm font-medium" }, connection.label, " ", /* @__PURE__ */ React.createElement("span", { className: "text-xs font-normal text-muted-foreground" }, "\xB7 ", t("profile", { profile: connection.profile }), " \xB7 ", connection.origin)), /* @__PURE__ */ React.createElement("span", { className: "text-xs text-muted-foreground", role: connection.state === "error" ? "alert" : void 0 }, stateText(connection)), connection.agents && connection.agents.length > 0 ? /* @__PURE__ */ React.createElement("span", { className: "text-xs text-muted-foreground" }, t("agents", { names: connection.agents.join(", ") })) : null, connection.state === "ok" && older(connection.version) ? /* @__PURE__ */ React.createElement("span", { className: "text-xs text-muted-foreground" }, t("upgrade", { recommended: RECOMMENDED })) : null));
}
function ReportLines({ report }) {
  const lines = ["created", "updated", "kept", "skipped"].filter((key) => report[key].length > 0).map((key) => t(`report.${key}`, { names: report[key].join(", ") }));
  return /* @__PURE__ */ React.createElement("p", { className: "text-xs text-muted-foreground", role: "status" }, lines.length > 0 ? lines.join(" \xB7 ") : t("report.none"));
}
function HermesSettings({ ctx }) {
  const [connections, setConnections] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState(null);
  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ctx.api("status");
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      setConnections(body.connections ?? []);
    } catch {
      setError(t("error.load"));
    } finally {
      setLoading(false);
    }
  }, [ctx]);
  React.useEffect(() => {
    void load();
  }, [load]);
  const create = async () => {
    setCreating(true);
    setError(null);
    setReport(null);
    try {
      const response = await ctx.api("agents", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setError(t("error.create", { message: body.error ?? String(response.status) }));
      else setReport(body);
    } catch {
      setError(t("error.create", { message: "network" }));
    } finally {
      setCreating(false);
    }
  };
  const openConnections = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("settings", "secrets/connections");
    ctx.navigate(`${url.pathname}${url.search}`);
  };
  const anyConnected = connections?.some((c) => c.state === "ok") ?? false;
  return /* @__PURE__ */ React.createElement("section", { className: "flex flex-col gap-5 p-4" }, /* @__PURE__ */ React.createElement("div", { className: "flex flex-col gap-1" }, /* @__PURE__ */ React.createElement("h2", { className: "text-base font-semibold" }, t("title")), /* @__PURE__ */ React.createElement("p", { className: "text-sm text-muted-foreground" }, t("intro"))), /* @__PURE__ */ React.createElement("div", { className: "flex flex-col gap-2" }, /* @__PURE__ */ React.createElement("h3", { className: "text-sm font-medium" }, t("connections")), connections && connections.length === 0 ? /* @__PURE__ */ React.createElement("p", { className: "text-sm text-muted-foreground" }, t("empty")) : null, connections && connections.length > 0 ? /* @__PURE__ */ React.createElement("ul", { className: "flex flex-col gap-2" }, connections.map((c) => /* @__PURE__ */ React.createElement(ConnectionRow, { key: c.id, connection: c }))) : null, error ? /* @__PURE__ */ React.createElement("p", { className: "text-sm text-destructive", role: "alert" }, error) : null, /* @__PURE__ */ React.createElement("div", { className: "flex flex-wrap gap-2 pt-1" }, /* @__PURE__ */ React.createElement(Button2, { variant: "outline", size: "sm", onClick: openConnections }, t("add")), /* @__PURE__ */ React.createElement(Button2, { variant: "outline", size: "sm", onClick: () => {
    void load();
  }, disabled: loading }, loading ? t("checking") : t("refresh")), /* @__PURE__ */ React.createElement(Button2, { size: "sm", onClick: () => {
    void create();
  }, disabled: creating || !anyConnected }, creating ? t("creating") : t("create"))), report ? /* @__PURE__ */ React.createElement(ReportLines, { report }) : null), /* @__PURE__ */ React.createElement("div", { className: "flex flex-col gap-1 rounded-md bg-muted/40 p-3" }, /* @__PURE__ */ React.createElement("p", { className: "text-xs text-muted-foreground" }, t("note.agents")), /* @__PURE__ */ React.createElement("p", { className: "text-xs text-muted-foreground" }, t("note.limits"))));
}
function apply(ctx) {
  return ctx.slots.register({ slot: "settings.section" }, () => /* @__PURE__ */ React.createElement(HermesSettings, { ctx }));
}
export {
  apply
};

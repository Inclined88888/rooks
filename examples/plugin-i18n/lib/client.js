// src/client.js
import React from "react";
import { createTranslator, getLocale } from "@rooks/ui";

// locales/en.json
var en_default = {
  widget: {
    title: "Hello in your language",
    greeting: "Hello, {name}!",
    notes: "{count, plural, =0 {No notes yet} one {# note} other {# notes}}",
    add: "Add a note",
    language: "Shown in {tag}"
  }
};

// locales/fr.json
var fr_default = {
  widget: {
    title: "Bonjour dans votre langue",
    greeting: "Bonjour, {name} !",
    notes: "{count, plural, =0 {Aucune note} one {# note} other {# notes}}",
    add: "Ajouter une note",
    language: "Affich\xE9 en {tag}"
  }
};

// locales/de.json
var de_default = {
  widget: {
    title: "Hallo in deiner Sprache",
    greeting: "Hallo, {name}!",
    notes: "{count, plural, =0 {Noch keine Notizen} one {# Notiz} other {# Notizen}}",
    add: "Notiz hinzuf\xFCgen"
  }
};

// locales/pl.json
var pl_default = {
  widget: {
    title: "Cze\u015B\u0107 w twoim j\u0119zyku",
    greeting: "Cze\u015B\u0107, {name}!",
    notes: "{count, plural, =0 {Brak notatek} one {# notatka} few {# notatki} many {# notatek} other {# notatki}}",
    add: "Dodaj notatk\u0119",
    language: "Wy\u015Bwietlane w j\u0119zyku {tag}"
  }
};

// src/client.js
var t = createTranslator({ en: en_default, fr: fr_default, de: de_default, pl: pl_default });
function apply(ctx) {
  function I18nWidget() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "section",
      { style: { margin: 12, padding: 16, display: "grid", gap: 8 } },
      React.createElement("strong", null, t("widget.greeting", { name: ctx.id })),
      // One message, every plural form of the language: `{count, plural, …}`.
      React.createElement("p", null, t("widget.notes", { count })),
      React.createElement("button", { type: "button", onClick: () => setCount((n) => n + 1) }, t("widget.add")),
      React.createElement("small", null, t("widget.language", { tag: getLocale() }))
    );
  }
  return ctx.slots.register(
    { slot: "cockpit.widget", widget: { title: t("widget.title") } },
    I18nWidget
  );
}
export {
  apply
};

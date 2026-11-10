/**
 * Rooks without the Rooks app (docs/design/0007 2.2). When there is no Rooks app for this computer, the launcher
 * (`ai-workspace`) opens Rooks in a Chrome or Edge window of its own, or in the usual browser, and never in a window
 * nobody chose. It tells the page which with ?shell=window, or ?shell=ask when nobody has chosen yet, and the page
 * says the same words once and offers the choice. The answer goes back to the launcher (POST /api/desktop/shell).
 */
export const NO_APP = "There is no Rooks app for this computer yet.";
export const QUESTION = `${NO_APP} Open Rooks in a Chrome or Edge window, or in your usual browser?`;
export const SEEN_KEY = "rooks.shellBarSeen";

export type ShellAnswer = "window" | "browser";
export type ShellBar = { word: "window" | "ask"; question: string; choices: { value: ShellAnswer; label: string }[] };
export type SeenStore = { get: (key: string) => string | null; set: (key: string, value: string) => void };

const CHOICES: ShellBar["choices"] = [
  { value: "window", label: "A window of its own" },
  { value: "browser", label: "My usual browser" },
];

/** The bar for this landing, or null. ?shell=ask always asks (no answer yet); ?shell=window says it once. */
export function barFor(search: string, seen: SeenStore): ShellBar | null {
  const word = new URLSearchParams(search).get("shell");
  if (word === "ask") return { word, question: QUESTION, choices: CHOICES };
  if (word === "window" && !seen.get(SEEN_KEY)) return { word, question: QUESTION, choices: CHOICES };
  return null;
}

/** The address without the launcher's word, so a reload or a copied link does not bring the bar back. */
export function withoutShell(path: string): string {
  const [beforeHash, hash = ""] = path.split("#");
  const [base, query = ""] = beforeHash.split("?");
  const params = new URLSearchParams(query);
  params.delete("shell");
  const rest = params.toString();
  return base + (rest ? `?${rest}` : "") + (hash ? `#${hash}` : "");
}

/** What the bar says after an answer. */
export function savedLine(answer: ShellAnswer): string {
  return answer === "window"
    ? "Saved. Next time Rooks opens in a Chrome or Edge window of its own."
    : "Saved. Next time Rooks opens in your usual browser.";
}

/** localStorage, or nothing when the browser keeps none (a private window). */
export const localSeen: SeenStore = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* nothing kept: the bar may show again */ } },
};

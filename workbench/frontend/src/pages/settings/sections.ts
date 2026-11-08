/**
 * The settings categories, in the order of the left list (plain words, no protocol names). Shared with the command
 * menu, which opens each one, without loading the Settings page.
 */
export const SETTINGS_SECTIONS: { id: string; label: string; line: string }[] = [
  { id: "general", label: "General", line: "The workspace name, the model new chats use, and how you sign in." },
  { id: "agents", label: "Agents", line: "The chat assistant, asking from anywhere, voice, and your phone." },
  { id: "models", label: "Models", line: "Sign in with a plan, paste a key, or run a model on this computer." },
  { id: "tools", label: "Tools", line: "This computer and the browser, and opening Rooks elsewhere." },
  { id: "skills", label: "Skills & rules", line: "Saved ways of working, standing instructions, and memory." },
  { id: "apps", label: "Connect", line: "Mail and calendar, a key you already have, and tools." },
  { id: "appearance", label: "Appearance", line: "Light, dark or high contrast, the typeface and text size." },
  { id: "privacy", label: "Privacy", line: "What stays on this computer, and what leaves only when you say yes." },
  { id: "advanced", label: "Advanced", line: "Developer tools, prices, usage, and history." },
];

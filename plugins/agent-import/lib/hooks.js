// src/hooks.ts
import React from "react";

// src/contract.ts
var SOURCE_SLOT = "agentimport.source";

// src/hooks.ts
var CONTEXT_KEY = /* @__PURE__ */ Symbol.for("timon.plugin.agent-import.context");
function agentImportContext() {
  const holder = globalThis;
  holder[CONTEXT_KEY] ??= React.createContext(null);
  return holder[CONTEXT_KEY];
}
function useAgentImport() {
  return React.useContext(agentImportContext());
}
export {
  SOURCE_SLOT,
  agentImportContext,
  useAgentImport
};

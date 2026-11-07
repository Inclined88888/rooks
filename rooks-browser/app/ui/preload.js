// The only bridge between the browser's own UI page and the main process. Web pages never get this file.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld("rooks", {
  newTab: call("tab:new"), closeTab: call("tab:close"), activate: call("tab:activate"), go: call("tab:go"),
  back: call("tab:back"), forward: call("tab:forward"), reload: call("tab:reload"),
  setPanel: call("ui:panel"), ready: call("ui:ready"),
  taskStatus: call("task:status"), startTask: call("task:start"), getTask: call("task:get"),
  answer: call("task:answer"), stopTask: call("task:stop"), openExternal: call("open:external"),
  onTabs: (fn) => ipcRenderer.on("tabs", (_e, d) => fn(d)),
  onHelper: (fn) => ipcRenderer.on("helper", (_e, d) => fn(d)),
  onFocus: (fn) => ipcRenderer.on("focus", (_e, d) => fn(d)),
});

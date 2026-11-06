// The annotation bubble's preload (TODO #481): a handful of verbs toward the main process and three
// listeners, nothing else of Electron. The bubble is Timon's own document; the page never reaches it.
// A sandboxed preload can require nothing but `electron`: the channel names repeat native-browser-bubble.ts.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const send = (message: Record<string, unknown>) => ipcRenderer.send('timon:annotation-bubble', message);
const listen = (channel: string) => (listener: (value: unknown) => void) => {
  ipcRenderer.on(channel, (_event: unknown, value: unknown) => listener(value));
};
contextBridge.exposeInMainWorld('timonBubble', {
  ready: () => send({ type: 'ready' }),
  draft: (text: unknown) => send({ type: 'draft', text: String(text) }),
  add: (text: unknown) => send({ type: 'add', text: String(text) }),
  send: (text: unknown) => send({ type: 'send', text: String(text) }),
  cancel: () => send({ type: 'cancel' }),
  remove: () => send({ type: 'remove' }),
  height: (height: unknown) => send({ type: 'height', height: Number(height) }),
  pin: (key: unknown) => send({ type: 'pin', key: String(key) }),
  onShow: listen('timon:annotation-bubble-show'),
  onState: listen('timon:annotation-bubble-state'),
  onPins: listen('timon:annotation-bubble-pins'),
});

#!/usr/bin/env node
/** Browser-only MCP. Identity and the fixed profile are derived from the mission
 * token by the daemon. Never read daemon-token and never launch a local Chrome. */
import readline from 'node:readline';
import { open, unlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

const origin = process.env.TIMON_ORCH_URL || 'http://127.0.0.1:3000';
const token = process.env.TIMON_API_TOKEN;
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const num = { type: 'number' };
const FILE_CHUNK_BYTES = 128 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const tools = [
  { name: 'list_pages', description: 'List tabs in the browser profile assigned to this mission.', inputSchema: schema() },
  { name: 'navigate_page', description: 'Navigate the active tab in the assigned browser profile.', inputSchema: schema({ url: str, type: { type: 'string', enum: ['url','back','forward','reload'] } }) },
  { name: 'new_page', description: 'Open a tab in the assigned profile.', inputSchema: schema({ url: str }) },
  { name: 'select_page', description: 'Select a tab returned by list_pages.', inputSchema: schema({ pageId: str }, ['pageId']) },
  { name: 'close_page', description: 'Close a tab in the assigned profile.', inputSchema: schema({ pageId: str }, ['pageId']) },
  { name: 'take_screenshot', description: 'See the currently displayed page in this profile.', inputSchema: schema() },
  { name: 'take_snapshot', description: 'Read visible page text and numbered interactive elements. Refresh after navigation.', inputSchema: schema() },
  { name: 'click', description: 'Click an element uid from take_snapshot, or page coordinates.', inputSchema: schema({ uid: str, x: num, y: num }) },
  { name: 'fill', description: 'Fill an input or textarea identified by its snapshot uid.', inputSchema: schema({ uid: str, value: str }, ['uid','value']) },
  { name: 'press_key', description: 'Send a key (Enter, Tab, Escape, ArrowDown…) to the active page.', inputSchema: schema({ key: str }, ['key']) },
  { name: 'scroll_page', description: 'Scroll at a page location.', inputSchema: schema({ x: num, y: num, deltaX: num, deltaY: num }, ['deltaY']) },
  { name: 'evaluate_script', description: 'Run a JavaScript function in the active page of the assigned profile.', inputSchema: schema({ function: str }, ['function']) },
  { name: 'resize_page', description: 'Set the viewport size in CSS pixels.', inputSchema: schema({ width: num, height: num, mobile: { type: 'boolean' } }, ['width','height']) },
  { name: 'list_credentials', description: 'List saved login metadata in this mission profile, plus the values the user typed for this mission with secret_request and an origin (ids sr-…). Passwords and full usernames are never returned.', inputSchema: schema() },
  { name: 'fill_credential', description: 'Fill a saved login, or a value from secret_request (id sr-…: its password or one-time-code field only, the username is yours to fill), by ID only. The current page and form must have the exact origin; this does not submit the form. A once value is spent by the fill.', inputSchema: schema({ credentialId: str }, ['credentialId']) },
  { name: 'handle_dialog', description: 'Accept or dismiss a pending JavaScript dialog from list_pages; optionally answer a prompt. Site permission requests require the user.', inputSchema: schema({ dialogId: str, accept: { type: 'boolean' }, promptText: str }, ['dialogId','accept']) },
  { name: 'upload_file', description: 'Select files from the agent filesystem for a pending file chooser from list_pages. Open the site’s file picker first. Up to 100 MiB per file; multiple files require a multiple chooser.', inputSchema: schema({ chooserId: str, filePaths: { type: 'array', items: str, minItems: 1, maxItems: 20 } }, ['chooserId','filePaths']) },
  { name: 'hover', description: 'Hover an element uid from take_snapshot.', inputSchema: schema({ uid: str }, ['uid']) },
  { name: 'drag', description: 'Drag an element onto another one, both identified by snapshot uids.', inputSchema: schema({ from_uid: str, to_uid: str }, ['from_uid','to_uid']) },
  { name: 'fill_form', description: 'Fill several inputs, textareas or selects at once, identified by snapshot uids.', inputSchema: schema({ elements: { type: 'array', minItems: 1, maxItems: 50, items: schema({ uid: str, value: str }, ['uid','value']) } }, ['elements']) },
  { name: 'wait_for', description: 'Wait until the given text appears on the active page.', inputSchema: schema({ text: str, timeout: num }, ['text']) },
  { name: 'list_console_messages', description: 'List console messages, uncaught errors and browser warnings of the active page since it loaded. Reporting starts on the first debug call, which also replays what the page had already logged.', inputSchema: schema({ pageSize: num, pageIdx: num, types: { type: 'array', items: str } }) },
  { name: 'get_console_message', description: 'Get a console message by msgid from list_console_messages, with its arguments and stack.', inputSchema: schema({ msgid: num }, ['msgid']) },
  { name: 'list_network_requests', description: 'List network requests of the active page since it loaded (recorded from the first debug call; reload to capture the page load).', inputSchema: schema({ pageSize: num, pageIdx: num, resourceTypes: { type: 'array', items: { type: 'string', enum: ['document','stylesheet','image','media','font','script','texttrack','xhr','fetch','prefetch','eventsource','websocket','manifest','signedexchange','ping','cspviolationreport','preflight','other'] } } }) },
  { name: 'get_network_request', description: 'Get a request by reqid from list_network_requests: headers, status, timing and response body (text, up to 100 kB). Cookie, Set-Cookie and Authorization values are redacted.', inputSchema: schema({ reqid: num }, ['reqid']) },
  { name: 'emulate', description: 'Throttle the active page: network conditions and/or CPU slowdown (1 = none). The user sees the same throttled page.', inputSchema: schema({ networkConditions: { type: 'string', enum: ['No emulation','Offline','Slow 3G','Fast 3G','Slow 4G','Fast 4G'] }, cpuThrottlingRate: { type: 'number', minimum: 1, maximum: 20 } }) },
  { name: 'performance_start_trace', description: 'Start recording performance on the active page. With reload, reloads it first; with autoStop, returns the summary once loaded.', inputSchema: schema({ reload: { type: 'boolean' }, autoStop: { type: 'boolean' } }) },
  { name: 'performance_stop_trace', description: 'Stop the recording and return a summary: script, layout and style time, JS heap, navigation timing and Core Web Vitals (LCP, CLS, INP, long tasks). No raw trace file.', inputSchema: schema() },
  { name: 'download_file', description: 'Copy a completed download from list_pages to a new absolute file path on the agent filesystem. Existing files are never overwritten; browser host paths are not exposed.', inputSchema: schema({ downloadId: str, filePath: str }, ['downloadId','filePath']) },
];
async function command(action, extra = {}) {
  if (!token) throw new Error('A mission token is required. No fallback browser is permitted.');
  const response = await fetch(`${origin}/api/native-browser/mission/command`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...extra, action }), signal: AbortSignal.timeout(25_000), redirect: 'error',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Browser request failed (${response.status}).`);
  return body.result;
}
const snapshotScript = `(() => {
  document.querySelectorAll('[data-timon-browser-uid]').forEach(el => el.removeAttribute('data-timon-browser-uid'));
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
    .filter(el => { const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden'; }).slice(0,250);
  const elements = nodes.map((el,i) => { const uid=String(i+1); el.setAttribute('data-timon-browser-uid',uid); return {
    uid, tag:el.tagName.toLowerCase(), role:el.getAttribute('role'), type:el.getAttribute('type'),
    label:(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').slice(0,160)
  }; });
  return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,12000),elements};
})()`;
function elementExpression(uid, body) {
  if (!/^\d{1,4}$/.test(uid)) throw new Error('Use an element uid from take_snapshot.');
  return `(() => { const el=document.querySelector('[data-timon-browser-uid="${uid}"]'); if(!el)throw new Error('Element not found; take a new snapshot'); ${body} })()`;
}
const centerScript = "el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};";
function opaqueId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Supply a valid identifier returned by this browser.');
  return value;
}
function localFilePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Supply an absolute path on the agent filesystem.');
  return value;
}
async function uploadFiles(args) {
  const chooserId = opaqueId(args.chooserId);
  if (!Array.isArray(args.filePaths) || !args.filePaths.length || args.filePaths.length > 20) throw new Error('Supply between 1 and 20 file paths.');
  const files = [];
  const uploadIds = [];
  try {
    // Check all selected local files before starting a remote upload. Paths
    // stay in this MCP process; the browser host receives a name and bytes.
    for (const value of args.filePaths) {
      const path = localFilePath(value);
      const handle = await open(path, 'r');
      files.push({ handle, name: basename(path), size: 0 });
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Browser uploads require regular files of at most 100 MiB.');
      files.at(-1).size = info.size;
    }
    for (const file of files) {
      const started = await command('fileUploadBegin', { chooserId, name: file.name, size: file.size });
      const uploadId = opaqueId(started.uploadId);
      uploadIds.push(uploadId);
      let offset = 0;
      const bytes = Buffer.alloc(FILE_CHUNK_BYTES);
      while (offset < file.size) {
        const { bytesRead } = await file.handle.read(bytes, 0, Math.min(bytes.length, file.size - offset), offset);
        if (!bytesRead) throw new Error('The selected file changed during upload.');
        const next = await command('fileUploadChunk', { uploadId, offset, data: bytes.subarray(0, bytesRead).toString('base64') });
        offset += bytesRead;
        if (next.offset !== offset || next.uploadId !== uploadId) throw new Error('The browser returned an invalid upload offset.');
      }
    }
    return await command('fileUploadCommit', { chooserId, uploadIds });
  } catch (error) {
    if (uploadIds.length) await command('fileUploadCancel', { chooserId }).catch(() => {});
    throw error;
  } finally { await Promise.allSettled(files.map(file => file.handle.close())); }
}
async function downloadFile(args) {
  const downloadId = opaqueId(args.downloadId);
  const filePath = localFilePath(args.filePath);
  const file = await open(filePath, 'wx', 0o600);
  let complete = false;
  try {
    let offset = 0, size;
    while (true) {
      const chunk = await command('downloadRead', { downloadId, offset, length: FILE_CHUNK_BYTES });
      if (chunk.offset !== offset || !Number.isInteger(chunk.size) || chunk.size < 0 || chunk.size > MAX_FILE_BYTES
        || (size !== undefined && chunk.size !== size) || typeof chunk.data !== 'string'
        || chunk.data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) throw new Error('The browser returned an invalid download range.');
      const bytes = Buffer.from(chunk.data, 'base64');
      size = chunk.size;
      if (bytes.toString('base64') !== chunk.data || bytes.length > FILE_CHUNK_BYTES || offset + bytes.length > size
        || chunk.eof !== (offset + bytes.length === size) || (!bytes.length && !chunk.eof)) throw new Error('The browser returned an invalid download chunk.');
      await file.writeFile(bytes);
      offset += bytes.length;
      if (chunk.eof) { complete = true; return { downloadId, filePath, size }; }
    }
  } finally {
    await file.close();
    if (!complete) await unlink(filePath).catch(() => {});
  }
}
async function run(name, args) {
  if (!tools.some(tool => tool.name === name)) throw new Error('Unknown browser tool.');
  await command('start');
  switch (name) {
    case 'list_pages': return command('status');
    case 'navigate_page': return command(['back','forward','reload'].includes(args.type) ? args.type : 'navigate', { url: args.url });
    case 'new_page': return command('newTab', { url: args.url || 'about:blank' });
    case 'select_page': return command('activateTab', { tabId: args.pageId });
    case 'close_page': return command('closeTab', { tabId: args.pageId });
    case 'take_screenshot': return { screenshot: await command('screenshot') };
    case 'take_snapshot': return command('evaluate', { expression: snapshotScript });
    case 'evaluate_script': return command('evaluate', { expression: `(${args.function})()` });
    case 'click': {
      let x=args.x, y=args.y;
      if (args.uid) {
        const evaluated = await command('evaluate', { expression: elementExpression(args.uid, "el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};") });
        ({x,y} = evaluated.result);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Supply a uid or valid coordinates.');
      return command('input', { event: { type:'click',x,y } });
    }
    case 'fill': {
      await command('evaluate', { expression: elementExpression(args.uid, "if(!['INPUT','TEXTAREA'].includes(el.tagName))throw new Error('Not a text input');el.focus();el.select();return true;") });
      return command('input', { event: { type:'text',text:args.value } });
    }
    case 'press_key': return command('input', { event:{type:'key',key:args.key} });
    case 'scroll_page': return command('input', { event:{type:'wheel',x:args.x ?? 100,y:args.y ?? 100,deltaX:args.deltaX ?? 0,deltaY:args.deltaY} });
    case 'resize_page': return command('resize', { width:args.width,height:args.height,mobile:args.mobile === true });
    case 'list_credentials': return command('listCredentials');
    case 'fill_credential': return command('fillCredential', { credentialId: opaqueId(args.credentialId) });
    case 'handle_dialog': {
      if (typeof args.accept !== 'boolean' || (args.promptText !== undefined && (typeof args.promptText !== 'string' || args.promptText.length > 32_768))) throw new Error('Supply a dialog acceptance flag and optional prompt text.');
      return command('dialogRespond', { dialogId: opaqueId(args.dialogId), accept: args.accept, promptText: args.promptText });
    }
    case 'hover': {
      const { result } = await command('evaluate', { expression: elementExpression(args.uid, centerScript) });
      return command('input', { event: { type: 'move', x: result.x, y: result.y, button: 'none' } });
    }
    case 'drag': {
      const from = (await command('evaluate', { expression: elementExpression(args.from_uid, centerScript) })).result;
      const to = (await command('evaluate', { expression: elementExpression(args.to_uid, "const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};") })).result;
      await command('input', { event: { type: 'down', x: from.x, y: from.y, buttons: 1 } });
      for (const step of [0.25, 0.5, 0.75, 1]) {
        await command('input', { event: { type: 'move', x: from.x + (to.x - from.x) * step, y: from.y + (to.y - from.y) * step, buttons: 1 } });
      }
      return command('input', { event: { type: 'up', x: to.x, y: to.y } });
    }
    case 'fill_form': {
      if (!Array.isArray(args.elements) || !args.elements.length || args.elements.length > 50) throw new Error('Supply between 1 and 50 elements.');
      for (const { uid, value } of args.elements) {
        if (typeof value !== 'string') throw new Error('Each element needs a string value.');
        const kind = (await command('evaluate', { expression: elementExpression(uid, `if(el.tagName==='SELECT'){const v=${JSON.stringify(value)};const o=[...el.options].find(o=>o.value===v||o.text.trim()===v);if(!o)throw new Error('No such option: '+v);el.value=o.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'select';}if(!['INPUT','TEXTAREA'].includes(el.tagName))throw new Error('Not a form field');el.focus();el.select();return 'text';`) })).result;
        if (kind === 'text') await command('input', { event: { type: 'text', text: value } });
      }
      return { filled: args.elements.length };
    }
    case 'wait_for': {
      if (typeof args.text !== 'string' || !args.text) throw new Error('Supply the text to wait for.');
      const deadline = Date.now() + Math.min(Math.max(Number(args.timeout) || 10_000, 0), 60_000);
      const probe = `document.body?.innerText.includes(${JSON.stringify(args.text)}) ?? false`;
      while (!(await command('evaluate', { expression: probe })).result) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for "${args.text}".`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { found: args.text };
    }
    case 'list_console_messages': return command('consoleList', { pageSize: args.pageSize, pageIdx: args.pageIdx, types: args.types });
    case 'get_console_message': return command('consoleGet', { msgid: args.msgid });
    case 'list_network_requests': return command('networkList', { pageSize: args.pageSize, pageIdx: args.pageIdx, resourceTypes: args.resourceTypes });
    case 'get_network_request': return command('networkGet', { reqid: args.reqid });
    case 'emulate': return command('emulate', { networkConditions: args.networkConditions, cpuThrottlingRate: args.cpuThrottlingRate });
    case 'performance_start_trace': return command('performanceStart', { reload: args.reload === true, autoStop: args.autoStop === true });
    case 'performance_stop_trace': return command('performanceStop');
    case 'upload_file': return uploadFiles(args);
    case 'download_file': return downloadFile(args);
  }
}
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const lines = readline.createInterface({input:process.stdin});
lines.on('line', async line => {
  let msg;
  try { msg=JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  try {
    let result;
    if (msg.method === 'initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'timon-browser',version:'1.0.0'}};
    else if (msg.method === 'ping') result={};
    else if (msg.method === 'tools/list') result={tools};
    else if (msg.method === 'tools/call') {
      const value=await run(msg.params?.name,msg.params?.arguments ?? {});
      result={content:value?.screenshot
        ? [{type:'image',data:value.screenshot.data,mimeType:value.screenshot.mimeType}]
        : [{type:'text',text:JSON.stringify(value)}]};
    } else return send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}});
    send({jsonrpc:'2.0',id:msg.id,result});
  } catch(error) { send({jsonrpc:'2.0',id:msg.id,result:{isError:true,content:[{type:'text',text:error.message}]}}); }
});

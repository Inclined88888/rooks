import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import ts from 'typescript';

test('real engine WebContentsView streams while hidden and while attached to the desktop panel', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-engine-media-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(home, 'package.json'), '{"type":"module"}');
    for (const name of ['native-browser', 'native-browser-credentials', 'native-browser-media', 'native-browser-media-page', 'native-browser-protocol', 'native-browser-user-agent', 'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin', 'native-browser-recorder', 'native-browser-annotator']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(home, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    await writeFile(join(home, 'native-browser-preload.cjs'), ts.transpileModule(
      await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText);
    const bootstrap = String.raw`
const {app,dialog}=require('electron');
globalThis.fail=(...errors)=>{require('node:fs').writeSync(2,'[engine media smoke pid='+process.pid+' '+new Date().toISOString()+']\n'+errors.map(e=>e?.stack||String(e)).join('\n')+'\n');app.exit(1)};
dialog.showErrorBox=fail;dialog.showMessageBox=async(...args)=>{fail(...args);return{response:1}};dialog.showMessageBoxSync=(...args)=>{fail(...args);return 1};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
try{require('./smoke.cjs')}catch(error){fail(error)};
`;
    const fixture = String.raw`
const {app,BrowserWindow}=require('electron');const {createServer}=require('node:http');const assert=require('node:assert/strict');
const home=process.env.TIMON_HOME;app.setPath('userData',home+'/shell');app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
await app.whenReady();app.dock?.hide();
const {NativeBrowserEngine}=await import('./native-browser.js');const {NativeBrowserMedia}=await import('./native-browser-media.js');
const engine=new NativeBrowserEngine(home);const media=new NativeBrowserMedia(home,id=>engine.mediaSource(id));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Engine capture</title><style>html,body{margin:0}</style><canvas width="640" height="480"></canvas><script>const ctx=document.querySelector("canvas").getContext("2d");let x=0;setInterval(()=>{ctx.fillStyle="rgb("+(x++%255)+",80,160)";ctx.fillRect(0,0,640,480)},33)</script>')});
const panel=new BrowserWindow({show:false,width:800,height:700,useContentSize:true});
const receiver=new BrowserWindow({show:false,width:640,height:480,webPreferences:{backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
const cmd=(action,params={})=>engine.command({profileId:'profile-a',action,...params});
const capture=(action,params={})=>media.command({profileId:'profile-a',mediaActor:'viewer-one',action,...params});
try{
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/';
await cmd('start');await cmd('resize',{width:640,height:480,mobile:false});await cmd('navigate',{url});
for(let i=0;i<100;i++){if((await cmd('evaluate',{expression:'document.title'})).result==='Engine capture')break;await delay(50)}
const source=engine.mediaSource('profile-a');console.log('ENGINE_SOURCE',JSON.stringify({type:source.webContents.getType(),url:source.webContents.getURL(),width:source.width,height:source.height,muted:source.webContents.isAudioMuted()}));
await source.webContents.executeJavaScript('window.audio=new AudioContext();const tone=audio.createOscillator();tone.connect(audio.destination);tone.start();audio.resume()',true);
for(const attached of [false,true]){
 if(attached){const ticket=await cmd('presentation');engine.attach(panel,{...ticket,profileId:'profile-a',bounds:{x:0,y:0,width:640,height:480}})}
 for(const audio of [false,true]){
  console.log('ENGINE_MEDIA_START',JSON.stringify({attached,audio}));
  const encoded=await capture('mediaStart',{audio});assert.match(encoded.mimeType,/video\/(webm|mp4)/);
  let bytes=0;for(let i=0;i<5;i++){const chunk=await capture('mediaRead',{mediaId:encoded.mediaId});bytes+=Buffer.from(chunk.data||'','base64').length;if(bytes>1000)break}
  assert.ok(bytes>1000,'engine source must produce encoded bytes');console.log('ENGINE_MEDIA_OK',JSON.stringify({attached,audio,bytes,mimeType:encoded.mimeType}));
  await capture('mediaStop',{mediaId:encoded.mediaId});
 }
}
await receiver.loadURL('data:text/html,<video autoplay muted playsinline></video>');
const offer=await receiver.webContents.executeJavaScript('(async()=>{window.pc=new RTCPeerConnection({iceServers:[]});window.stream=new MediaStream();window.ac=new AudioContext();window.an=ac.createAnalyser();const gain=ac.createGain();gain.gain.value=0;an.connect(gain);gain.connect(ac.destination);ac.resume();pc.ontrack=e=>{stream.addTrack(e.track);document.querySelector("video").srcObject=stream;document.querySelector("video").play();if(e.track.kind==="audio")ac.createMediaStreamSource(new MediaStream([e.track])).connect(an)};pc.addTransceiver("video",{direction:"recvonly"});pc.addTransceiver("audio",{direction:"recvonly"});await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>{if(pc.iceGatheringState==="complete")return resolve();pc.addEventListener("icegatheringstatechange",()=>{if(pc.iceGatheringState==="complete")resolve()})});return{type:pc.localDescription.type,sdp:pc.localDescription.sdp}})()',true);
const rtc=await capture('mediaOffer',{offer,audio:true});
await receiver.webContents.executeJavaScript('pc.setRemoteDescription('+JSON.stringify(rtc.answer)+')');
let stats;
for(let i=0;i<80;i++){
 stats=await receiver.webContents.executeJavaScript('(async()=>{const s=[...(await pc.getStats()).values()],a=new Float32Array(an.fftSize);an.getFloatTimeDomainData(a);return{frames:s.find(v=>v.type==="inbound-rtp"&&v.kind==="video")?.framesDecoded||0,rms:Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)/a.length),audio:s.find(v=>v.type==="inbound-rtp"&&v.kind==="audio")?.bytesReceived||0}})()');
 if(stats.frames>2&&stats.rms>0.01)break;await delay(100);
}
assert.ok(stats.frames>2,JSON.stringify(stats));assert.ok(stats.rms>0.01,JSON.stringify(stats));
const frame=await receiver.webContents.executeJavaScript('(()=>{const v=document.querySelector("video"),c=document.createElement("canvas");c.width=c.height=1;const ctx=c.getContext("2d");ctx.drawImage(v,v.videoWidth/2,v.videoHeight/2,1,1,0,0,1,1);return{width:v.videoWidth,height:v.videoHeight,color:[...ctx.getImageData(0,0,1,1).data]}})()');
assert.ok(frame.width<=640&&frame.height<=480,JSON.stringify(frame));assert.ok(Math.abs(frame.color[1]-80)<20&&Math.abs(frame.color[2]-160)<20,JSON.stringify(frame));
console.log('ENGINE_MEDIA_RTC_OK',JSON.stringify({stats,frame}));await capture('mediaStop',{mediaId:rtc.mediaId});
assert.equal(await source.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia({video:true}).then(()=>"unexpected",error=>error.name)',true),'NotAllowedError','a website cannot capture the host screen through internal browser streaming permissions');
assert.deepEqual((await cmd('status')).permissions,[],'internal streaming must not grant website camera or microphone permissions');
console.log('NATIVE_BROWSER_ENGINE_MEDIA_SMOKE_OK');
}finally{media.close();await engine.close();panel.destroy();receiver.destroy();await new Promise(resolve=>server.close(resolve))}
app.exit(0);
})().catch(fail);
`;
    new Script(bootstrap, { filename: 'bootstrap.cjs' });
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(home, 'bootstrap.cjs'), bootstrap);
    await writeFile(join(home, 'smoke.cjs'), fixture);
    const env = { ...process.env, TIMON_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, [join(home, 'bootstrap.cjs')], {
      env, timeout: 55_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Engine media smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    assert.match(result.stdout, /NATIVE_BROWSER_ENGINE_MEDIA_SMOKE_OK/);
    console.log(result.stdout.trim());
  } finally { await rm(home, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { Script } from 'node:vm';

test('hidden Electron sends encoded tab video and audio with WebRTC, WebM and MP4, with scoped viewers', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rooks-media-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(home, 'package.json'), '{"type":"module"}');
    for (const name of ['native-browser-media', 'native-browser-media-page', 'native-browser-protocol']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(home, `${name}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    }
    await writeFile(join(home, 'fixture.html'), `<!doctype html><canvas width="640" height="480"></canvas><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let x=0;
      setInterval(()=>{ctx.fillStyle='rgb('+(x++%255)+',80,160)';ctx.fillRect(0,0,640,480)},33);
      window.audio=new AudioContext();const tone=audio.createOscillator();tone.connect(audio.destination);tone.start();audio.resume();
      </script>`);
    await writeFile(join(home, 'receiver.html'), '<!doctype html><video autoplay muted playsinline></video>');
    await writeFile(join(home, 'smoke.cjs'), `
const {app,BrowserWindow,dialog}=require('electron');const fs=require('node:fs');
const fail=(...errors)=>{fs.writeSync(2,errors.map(e=>e?.stack||String(e)).join('\\n')+'\\n');app.exit(1)};
dialog.showErrorBox=fail;process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
app.on('window-all-closed',()=>{});app.setPath('userData',process.env.ROOKS_HOME+'/shell');
const assert=require('node:assert/strict'),home=process.env.ROOKS_HOME;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
await app.whenReady();app.dock?.hide();
const {NativeBrowserMedia}=await import('./native-browser-media.js');
const source=new BrowserWindow({show:false,width:640,height:480,useContentSize:true,webPreferences:{backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
source.webContents.setAudioMuted(true);await source.loadFile(home+'/fixture.html');
const media=new NativeBrowserMedia(home,id=>{if(id!=='profile-a')throw new Error('wrong profile');return {webContents:source.webContents,width:640,height:480}});
const baseSourceListeners=source.webContents.listenerCount('destroyed');
const cmd=(action,data={})=>media.command({profileId:'profile-a',mediaActor:'viewer-one',action,...data});
const receiver=new BrowserWindow({show:false,width:640,height:480,webPreferences:{backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
try{
await receiver.loadFile(home+'/receiver.html');
const offer=await receiver.webContents.executeJavaScript(\`(async()=>{window.pc=new RTCPeerConnection({iceServers:[]});window.stream=new MediaStream();pc.ontrack=e=>{stream.addTrack(e.track);document.querySelector('video').srcObject=stream;document.querySelector('video').play()};pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')r()})});return {type:pc.localDescription.type,sdp:pc.localDescription.sdp}})()\`,true);
assert.equal(await source.webContents.executeJavaScript('audio.state'),'running');console.log('MEDIA_OFFER');const rtc=await cmd('mediaOffer',{offer,audio:true});
await receiver.webContents.executeJavaScript('pc.setRemoteDescription('+JSON.stringify(rtc.answer)+')');
await receiver.webContents.executeJavaScript(\`window.ac=new AudioContext();window.an=ac.createAnalyser();const gain=ac.createGain();gain.gain.value=0;an.connect(gain);gain.connect(ac.destination);pc.addEventListener('track',e=>{if(e.track.kind==='audio')ac.createMediaStreamSource(new MediaStream([e.track])).connect(an)});if(stream.getAudioTracks().length)ac.createMediaStreamSource(stream).connect(an);ac.resume();\`,true);
let stats;
for(let i=0;i<80;i++){stats=await receiver.webContents.executeJavaScript(\`(async()=>{const stats=[...(await pc.getStats()).values()];const samples=new Float32Array(an.fftSize);an.getFloatTimeDomainData(samples);return {rms:Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length),frames:stats.find(s=>s.type==='inbound-rtp'&&s.kind==='video')?.framesDecoded||0,audio:stats.find(s=>s.type==='inbound-rtp'&&s.kind==='audio')?.bytesReceived||0,state:pc.connectionState}})()\`);if(stats.frames>2&&stats.audio>0&&stats.rms>0.01)break;await delay(100)}
assert.ok(stats.frames>2,JSON.stringify(stats));assert.ok(stats.audio>0,JSON.stringify(stats));assert.ok(stats.rms>0.01,'captured tab audio must contain the fixture tone: '+JSON.stringify(stats));
await assert.rejects(media.command({profileId:'profile-a',mediaActor:'wrong-viewer',action:'mediaRenew',mediaId:rtc.mediaId}),/not found/);
await assert.rejects(media.command({profileId:'profile-b',mediaActor:'viewer-one',action:'mediaRenew',mediaId:rtc.mediaId}),/not found/);
const checkFrame=async()=>{const frame=await receiver.webContents.executeJavaScript(\`(()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(v,v.videoWidth/2,v.videoHeight/2,1,1,0,0,1,1);return {width:v.videoWidth,height:v.videoHeight,color:[...ctx.getImageData(0,0,1,1).data]}})()\`);assert.ok(frame.width<=640&&frame.height<=480,JSON.stringify(frame));assert.ok(Math.abs(frame.color[1]-80)<20&&Math.abs(frame.color[2]-160)<20,'capture must contain only fixture tab: '+JSON.stringify(frame))};
await checkFrame();
await cmd('mediaStop',{mediaId:rtc.mediaId});
await receiver.webContents.executeJavaScript('pc.close()');
console.log('MEDIA_WEBRTC_OK',JSON.stringify(stats));
// Chromium has no AAC encoder on Linux: MP4 with audio exists only where the OS provides one.
const mp4Audio='video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const mp4AudioEncodable=await source.webContents.executeJavaScript('MediaRecorder.isTypeSupported('+JSON.stringify(mp4Audio)+')');
if(!mp4AudioEncodable){await assert.rejects(cmd('mediaStart',{audio:true,supportedMimeTypes:[mp4Audio]}),/not supported/);console.log('MEDIA_MP4_AUDIO_UNAVAILABLE',process.platform)}
const mp4Opus='video/mp4;codecs=avc1.42E01E,opus',mp4Video='video/mp4;codecs=avc1.42E01E';
const mp4OpusEncodable=await source.webContents.executeJavaScript('MediaRecorder.isTypeSupported('+JSON.stringify(mp4Opus)+')');
if(!mp4OpusEncodable)console.log('MEDIA_MP4_OPUS_UNAVAILABLE',process.platform);
// A viewer whose only audio format the host cannot encode gets silent video, not an error.
const silent=await cmd('mediaStart',{audio:true,supportedMimeTypes:[mp4AudioEncodable?'video/unsupported':mp4Audio,mp4Video]});
assert.equal(silent.mimeType.split(';')[0],'video/mp4');assert.equal(silent.audio,false,JSON.stringify(silent));await cmd('mediaStop',{mediaId:silent.mediaId});
for (const supportedMimeTypes of [undefined, ...(mp4AudioEncodable ? [[mp4Audio]] : []), ...(mp4OpusEncodable ? [[mp4Opus]] : [])]) {
const encoded=await cmd('mediaStart',{audio:true,supportedMimeTypes});assert.match(encoded.mimeType,supportedMimeTypes ? /video\\/mp4/ : /video\\/webm/);
await receiver.loadFile(home+'/receiver.html');
await receiver.webContents.executeJavaScript(\`window.ms=new MediaSource();document.querySelector('video').src=URL.createObjectURL(ms);window.opened=new Promise(r=>ms.addEventListener('sourceopen',()=>{window.sb=ms.addSourceBuffer(\`+JSON.stringify(encoded.mimeType)+\`);r()}));opened\`);
await receiver.webContents.executeJavaScript(\`window.ac=new AudioContext();window.an=ac.createAnalyser();const gain=ac.createGain();gain.gain.value=0;an.connect(gain);gain.connect(ac.destination);ac.createMediaElementSource(document.querySelector('video')).connect(an);document.querySelector('video').muted=false;window.maxRms=0;setInterval(()=>{const s=new Float32Array(an.fftSize);an.getFloatTimeDomainData(s);window.maxRms=Math.max(maxRms,Math.sqrt(s.reduce((sum,x)=>sum+x*x,0)/s.length))},10);ac.resume();\`,true);
let chunks=0,bytes=0,playable=false,encodedRms=0;
for(let i=0;i<35;i++){
 const chunk=await cmd('mediaRead',{mediaId:encoded.mediaId});if(!chunk.data)continue;
 assert.equal(chunk.sequence,chunks++);bytes+=Buffer.from(chunk.data,'base64').length;
 await receiver.webContents.executeJavaScript(\`(async()=>{const data=Uint8Array.from(atob(\`+JSON.stringify(chunk.data)+\`),c=>c.charCodeAt(0));await new Promise((resolve,reject)=>{sb.addEventListener('updateend',resolve,{once:true});sb.addEventListener('error',reject,{once:true});sb.appendBuffer(data)});if(sb.buffered.length){const end=sb.buffered.end(sb.buffered.length-1),v=document.querySelector('video');if(end-v.currentTime>2)v.currentTime=Math.max(sb.buffered.start(0),end-0.4)}document.querySelector('video').play().catch(()=>{});return true})()\`);
 playable=await receiver.webContents.executeJavaScript('document.querySelector("video").videoWidth>0 && document.querySelector("video").currentTime>0');
 encodedRms=await receiver.webContents.executeJavaScript('maxRms');
 if(playable&&chunks>5&&encodedRms>0.01)break;
}
assert.ok(playable,'encoded stream must decode in an actual browser: '+encoded.mimeType+' '+await receiver.webContents.executeJavaScript(\`JSON.stringify({time:document.querySelector('video').currentTime,width:document.querySelector('video').videoWidth,state:document.querySelector('video').readyState,error:document.querySelector('video').error,buffer:[...Array(sb.buffered.length)].map((_,i)=>[sb.buffered.start(i),sb.buffered.end(i)])})\`));assert.ok(bytes>1000);assert.ok(encodedRms>0.01,'encoded audio must contain the fixture tone: '+encoded.mimeType+' '+await receiver.webContents.executeJavaScript(\`JSON.stringify({time:document.querySelector('video').currentTime,width:document.querySelector('video').videoWidth,state:document.querySelector('video').readyState,paused:document.querySelector('video').paused,audioState:ac.state,error:document.querySelector('video').error,buffer:[...Array(sb.buffered.length)].map((_,i)=>[sb.buffered.start(i),sb.buffered.end(i)])})\`));console.log('MEDIA_ENCODED_OK',encoded.mimeType,chunks,bytes,'audioRms='+encodedRms);
await checkFrame();await cmd('mediaStop',{mediaId:encoded.mediaId});
await assert.rejects(cmd('mediaRead',{mediaId:encoded.mediaId}),/not found/);
}
await assert.rejects(cmd('mediaStart',{supportedMimeTypes:['video/unsupported']}),/not supported/);
const pending=cmd('mediaStart',{audio:false});
const rejected=assert.rejects(pending,/cancelled|destroyed/);
await assert.rejects(cmd('mediaStart',{audio:false}),/already starting/);
media.closeProfile('profile-a');await rejected;
assert.equal(source.webContents.listenerCount('destroyed'),baseSourceListeners,'stopped media must remove source listeners');
console.log('NATIVE_BROWSER_MEDIA_SMOKE_OK');
}finally{media.close();source.destroy();receiver.destroy()}
app.exit(0);
})().catch(fail);
`);
    new Script(await readFile(join(home, 'smoke.cjs'), 'utf8'), { filename: 'media-smoke.cjs' });
    const result = await promisify(execFile)(electron, [join(home, 'smoke.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ROOKS_HOME: home }, timeout: 55_000, maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`Media smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    assert.match(result.stdout, /NATIVE_BROWSER_MEDIA_SMOKE_OK/);
    console.log(result.stdout.trim());
  } finally { await rm(home, { recursive: true, force: true }); }
});

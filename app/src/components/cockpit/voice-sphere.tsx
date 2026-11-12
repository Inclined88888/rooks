'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { derivePalettes, type VoiceSpherePalettes, type VoiceSphereState } from '@/lib/voice-sphere-palette';

export type { VoiceSphereState };

type Props = {
  state: VoiceSphereState;
  /** Analyser plugged into the microphone; null if the stream could not open,
   *  in which case the sphere pulses on a synthetic rhythm. */
  analyser: AnalyserNode | null;
};

/** The three state palettes, derived from the theme's `--primary` token
 *  (see `derivePalettes`). */
function resolvePalettes(): VoiceSpherePalettes {
  if (typeof document === 'undefined') return derivePalettes(null);
  return derivePalettes(getComputedStyle(document.documentElement).getPropertyValue('--primary'));
}

/** 3D simplex (Ashima/IQ, public domain): organic noise computed on the GPU,
 *  to deform the sphere without a CPU loop over the vertices every frame. */
const GLSL_SNOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const CORE_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uFreq;
varying float vDisp;
varying vec3 vNormal;
varying vec3 vView;
${GLSL_SNOISE}
void main() {
  // Two octaves are enough: the low one gives the swell, the high one the nervous grain.
  float n = snoise(position * uFreq + uTime * 0.6);
  float n2 = snoise(position * uFreq * 2.6 - uTime * 1.15) * 0.35;
  vDisp = n + n2;
  vec3 p = position + normal * vDisp * uAmp;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const CORE_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uGlow;
uniform float uLevel;
varying float vDisp;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.2);
  vec3 col = mix(uColorA, uColorB, clamp(vDisp * 0.6 + 0.5, 0.0, 1.0));
  // Fresnel edge deliberately > 1.0 as the level rises: that overshoot is what
  // the bloom catches to make the silhouette glow.
  col += uGlow * fres * (0.9 + uLevel * 2.4);
  col += uGlow * uLevel * 0.35;
  gl_FragColor = vec4(col, 0.94);
  /*OUTPUT*/
}
`;

const HALO_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const HALO_FRAG = /* glsl */ `
uniform vec3 uGlow;
uniform float uLevel;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  // Back face: the fresnel is inverted, lighting the outer ring.
  float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 3.0);
  gl_FragColor = vec4(uGlow, rim * (0.35 + uLevel * 0.9));
  /*OUTPUT*/
}
`;

/**
 * sRGB encoding of the output, done by the shader, and only in light mode.
 *
 * three.js only injects the `colorspace_fragment` chunk into its built-in
 * materials: a `ShaderMaterial` writes its linear colours as they are. On
 * desktop that is what we want, the composer's `OutputPass` converts at the
 * end of the chain. In light mode there is no composer: without this chunk,
 * the sphere would come out clearly darker and duller on a phone, precisely
 * the platform this mode exists for.
 */
function encoderSortie(source: string, lite: boolean): string {
  return source.replace('/*OUTPUT*/', lite ? '#include <colorspace_fragment>' : '');
}

type Comet = {
  group: THREE.Group;
  speed: number;
};

/** Audio-reactive "galactic" orb: shader core (simplex noise + fresnel),
 *  additive halo, comets with trails in orbit, star dust, bloom on desktop.
 *  Loaded with `dynamic(..., { ssr:false })` by `VoiceSphereInline`: three.js
 *  touches `window` on import.
 *
 *  The visual state and the analyser are read through refs in the rAF loop:
 *  recreating the scene on every state change would recreate a WebGL context,
 *  and the browser caps their number (~16); on a cockpit left open for hours,
 *  rendering would end up lost. */
export default function VoiceSphere({ state, analyser }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<VoiceSphereState>(state);
  const analyserRef = useRef<AnalyserNode | null>(analyser);
  stateRef.current = state;
  analyserRef.current = analyser;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Mobile budget decided once at mount: recreating a composer on the fly
    // would mean touching the WebGL context we refuse to recycle. The box size
    // is no longer the criterion: the sphere now lives in a small square by
    // the input, where the bloom passes are cheap on a desktop GPU. What
    // still calls for the light path is a phone-class device.
    const lite = window.matchMedia('(pointer: coarse)').matches || window.devicePixelRatio > 2.5;

    const renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    // Distance that keeps the comet orbits inside the SHORTER side of the box:
    // in a small, possibly wide strip the sphere must stay whole, never
    // cropped. The dust shell beyond that radius is faded by the host's mask.
    const FRAME_RADIUS = 3.1;
    const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const fitCamera = (w: number, h: number) => {
      const aspect = w / h;
      camera.aspect = aspect;
      camera.position.z = FRAME_RADIUS / (TAN_HALF_FOV * Math.min(1, aspect));
      camera.updateProjectionMatrix();
    };
    fitCamera(host.clientWidth || 1, host.clientHeight || 1);

    // Mutable on purpose: a theme swap rewrites it in place and the render
    // loop's colour lerp carries the orb to the new colours, with no uniform
    // to touch and no scene to rebuild.
    const palettes = resolvePalettes();
    const onThemePainted = () => Object.assign(palettes, resolvePalettes());
    window.addEventListener('rooks:theme-painted', onThemePainted);
    const pal = palettes[stateRef.current];
    const colorA = new THREE.Color(pal.a);
    const colorB = new THREE.Color(pal.b);
    const glow = new THREE.Color(pal.glow);
    // Target of the palette lerp, reused from frame to frame: three colours
    // allocated on every rAF are 180 objects a second to collect for nothing;
    // on a phone, the GC ends up showing.
    const cible = new THREE.Color();

    // Core: a smooth sphere deformed in the vertex shader, zero CPU loop.
    const coreGeo = new THREE.SphereGeometry(1.15, lite ? 64 : 96, lite ? 64 : 96);
    const coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: encoderSortie(CORE_FRAG, lite),
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.2 },
        uFreq: { value: 2.2 },
        uLevel: { value: 0 },
        uColorA: { value: colorA },
        uColorB: { value: colorB },
        uGlow: { value: glow },
      },
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    scene.add(core);

    // Halo: an inverted shell in additive blending, the light "spills" out of
    // the core even without bloom (the fallback glow of mobile mode).
    const haloGeo = new THREE.SphereGeometry(1.6, 48, 48);
    const haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: encoderSortie(HALO_FRAG, lite),
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uGlow: { value: glow },
        uLevel: { value: 0 },
      },
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    scene.add(halo);

    // Comets: a bright head + an arc trail with fading colours. The trail is
    // STATIC geometry in its orbit's frame: the group's rotation creates the
    // motion, at zero cost per frame.
    const cometRoot = new THREE.Group();
    scene.add(cometRoot);
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const headGeo = new THREE.SphereGeometry(0.045, 8, 8);
    const headMat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    headMat.color.copy(glow);
    trailMat.color.copy(glow);
    const comets: Comet[] = [];
    const trailGeos: THREE.BufferGeometry[] = [];
    const N_COMETS = lite ? 5 : 8;
    const TRAIL_PTS = 48;
    for (let c = 0; c < N_COMETS; c += 1) {
      const orbit = new THREE.Group();
      const r = 1.9 + Math.random() * 1.1;
      orbit.rotation.set(
        (Math.random() - 0.5) * 1.6,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 1.6,
      );
      const pts = new Float32Array(TRAIL_PTS * 3);
      const cols = new Float32Array(TRAIL_PTS * 3);
      const arc = 1.1 + Math.random() * 0.5;
      for (let i = 0; i < TRAIL_PTS; i += 1) {
        const a = -(i / (TRAIL_PTS - 1)) * arc;
        pts[i * 3] = Math.cos(a) * r;
        pts[i * 3 + 1] = 0;
        pts[i * 3 + 2] = Math.sin(a) * r;
        // Quadratic fade: in additive blending, a dark colour is transparency.
        const f = (1 - i / (TRAIL_PTS - 1)) ** 2;
        cols[i * 3] = f;
        cols[i * 3 + 1] = f;
        cols[i * 3 + 2] = f;
      }
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      trailGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      trailGeos.push(trailGeo);
      orbit.add(new THREE.Line(trailGeo, trailMat));
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(r, 0, 0);
      orbit.add(head);
      cometRoot.add(orbit);
      comets.push({ group: orbit, speed: (0.4 + Math.random() * 0.6) * (c % 2 ? 1 : -1) });
    }

    // Star dust: a distant spherical shell for depth.
    const N_DUST = lite ? 450 : 1000;
    const dustPos = new Float32Array(N_DUST * 3);
    const dustCol = new Float32Array(N_DUST * 3);
    for (let i = 0; i < N_DUST; i += 1) {
      const rr = 2.6 + Math.random() * 2.2;
      const u = Math.random() * 2 - 1;
      const ph = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      dustPos[i * 3] = Math.cos(ph) * s * rr;
      dustPos[i * 3 + 1] = u * rr * 0.7;
      dustPos[i * 3 + 2] = Math.sin(ph) * s * rr;
      const lum = 0.15 + Math.random() * 0.6;
      dustCol[i * 3] = lum;
      dustCol[i * 3 + 1] = lum;
      dustCol[i * 3 + 2] = lum;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
    const dustMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.02,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    dustMat.color.copy(glow);
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);

    // Bloom: off mobile only. The UnrealBloomPass costs several full-screen
    // passes, prohibitive on a phone GPU. On mobile, the additive halo and
    // the fresnel do most of the lighting work.
    let composer: EffectComposer | null = null;
    let bloom: UnrealBloomPass | null = null;
    if (!lite) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(
        new THREE.Vector2(host.clientWidth, host.clientHeight),
        0.7,
        0.55,
        0.18,
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }

    const bins = new Uint8Array(64);
    let smoothLevel = 0;
    let raf = 0;
    const clock = new THREE.Clock();

    const micLevel = (): number => {
      const an = analyserRef.current;
      if (!an) return 0;
      const n = Math.min(bins.length, an.frequencyBinCount);
      an.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += bins[i] ?? 0;
      return sum / (n * 255);
    };

    const render = () => {
      const t = clock.getElapsedTime();
      const st = stateRef.current;
      const target = palettes[st];

      // Target level: the microphone when it can be measured, a synthetic rhythm
      // otherwise. On mobile the microphone belongs to the speech recognition
      // engine: an inert sphere reads as a crash, so each state keeps its own
      // fallback pulse.
      let level: number;
      if (st === 'speaking') {
        level = 0.5 + 0.4 * Math.abs(Math.sin(t * 9) * Math.sin(t * 3.7));
      } else if (st === 'listening') {
        level = analyserRef.current
          ? Math.min(1, micLevel() * 2.2)
          : 0.16 + 0.1 * Math.sin(t * 1.7);
      } else {
        // Thinking: a short, tight beat, the energy is held in.
        level = 0.22 + 0.14 * Math.abs(Math.sin(t * 5.2)) * (0.6 + 0.4 * Math.sin(t * 0.9));
      }
      smoothLevel += (level - smoothLevel) * 0.12;

      // Smooth colour transition on every state change.
      colorA.lerp(cible.set(target.a), 0.05);
      colorB.lerp(cible.set(target.b), 0.05);
      glow.lerp(cible.set(target.glow), 0.05);
      headMat.color.copy(glow);
      trailMat.color.copy(glow);
      dustMat.color.copy(glow);

      // Character of the deformation: a broad swell when speaking, a tight shiver
      // when thinking, a slow breath when listening.
      const amp = st === 'speaking' ? 0.18 + smoothLevel * 0.4 : st === 'thinking' ? 0.1 : 0.08 + smoothLevel * 0.25;
      const freq = st === 'speaking' ? 3.4 : st === 'thinking' ? 5.2 : 2.2;
      const cu = coreMat.uniforms;
      cu.uTime!.value = t;
      cu.uLevel!.value = smoothLevel;
      cu.uAmp!.value += (amp - (cu.uAmp!.value as number)) * 0.08;
      cu.uFreq!.value += (freq - (cu.uFreq!.value as number)) * 0.08;
      haloMat.uniforms.uLevel!.value = smoothLevel;

      const spin = st === 'speaking' ? 3.2 : st === 'thinking' ? 1.9 : 1;
      core.rotation.y += 0.002 * spin;
      dust.rotation.y += 0.0006 * spin;
      for (const c of comets) c.group.rotation.y += 0.006 * spin * c.speed;
      // Thinking: the orbits tighten around the core, the energy converges;
      // speaking: they widen slightly.
      const cometScale = st === 'thinking' ? 0.72 : st === 'speaking' ? 1.06 : 1;
      cometRoot.scale.setScalar(
        cometRoot.scale.x + (cometScale - cometRoot.scale.x) * 0.05,
      );

      if (bloom) {
        const strength = st === 'speaking' ? 1.1 + smoothLevel * 0.9 : st === 'thinking' ? 0.85 : 0.55 + smoothLevel * 0.7;
        bloom.strength += (strength - bloom.strength) * 0.08;
      }

      if (composer) composer.render();
      else renderer.render(scene, camera);
      raf = window.requestAnimationFrame(render);
    };
    raf = window.requestAnimationFrame(render);

    const onResize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      composer?.setSize(w, h);
      fitCamera(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      // Exhaustive release: an undisposed WebGL context survives the React
      // unmount and piles up on every opening of voice mode.
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('rooks:theme-painted', onThemePainted);
      coreGeo.dispose();
      coreMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      headGeo.dispose();
      headMat.dispose();
      trailMat.dispose();
      for (const g of trailGeos) g.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      bloom?.dispose();
      composer?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className="size-full" aria-hidden />;
}

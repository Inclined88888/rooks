/**
 * The job accessories: a hand tool held at the bottom right of the head (the
 * teacher also wears a mortarboard). Each tool is drawn around its own
 * origin, then placed and tilted.
 */

import { createElement, type ReactElement, type ReactNode } from 'react';
import type { MascotAccessory } from './agent-look';
import { readMascotSvg, type MascotPartId, type MascotSvgNode } from '@/lib/mascot/parts-contract';
import { mascotPartOf } from './mascot-parts';

/** Built on demand: a table of elements would be created at import, mascot or not. */
type Tool = { deg: number; body: () => ReactNode };
const ARIAL = 'Arial,Helvetica,sans-serif';

const TOOLS: Readonly<Record<Exclude<MascotAccessory, 'none'>, Tool>> = {
  loupe: { deg: 0, body: () => (<>
    <line x1="6" y1="6" x2="14" y2="14" stroke="#7a4f2a" strokeWidth="5" strokeLinecap="round" />
    <circle cx="-1" cy="-1" r="10" fill="#cfe9ff" fillOpacity=".26" stroke="#dfe3e8" strokeWidth="3.4" />
    <path d="M-7 -4 A7 7 0 0 1 -2 -8" fill="none" stroke="#fff" strokeOpacity=".75" strokeWidth="1.7" strokeLinecap="round" />
  </>) },
  pen: { deg: 38, body: () => (<>
    <rect x="-3" y="-14" width="6" height="21" rx="2" fill="#e2463b" />
    <rect x="-3" y="-14" width="6" height="6" rx="2" fill="#b8322a" />
    <rect x="2.2" y="-12" width="1.4" height="9" rx=".7" fill="#b8322a" />
    <path d="M-3 7 L3 7 L0 14 Z" fill="#f2d3b0" />
    <path d="M-1.1 11.5 L1.1 11.5 L0 14 Z" fill="#c22" />
  </>) },
  quill: { deg: 32, body: () => (<>
    <path d="M0 12 C 8 1, 7 -9, 1 -16 C -6 -9, -7 1, 0 12 Z" fill="#f6f1e7" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M0 12 Q 1 -2, 1 -15" fill="none" stroke="#b9ae9b" strokeWidth="1" />
    <path d="M1 -4 l4.5 -2.5 M1 -9 l3.5 -2.5 M.6 0 l-4.5 -2.5" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M-1.3 11 L0 16 L1.3 11 Z" fill="#333" />
  </>) },
  hammer: { deg: -32, body: () => (<>
    <rect x="-1.9" y="-6" width="3.8" height="20" rx="1.6" fill="#9a6a3c" />
    <rect x="-1.9" y="9" width="3.8" height="5" rx="1.6" fill="#7a4f2a" />
    <rect x="-9" y="-12" width="18" height="7" rx="1.8" fill="#8e949c" />
    <rect x="-9" y="-12" width="18" height="2.2" rx="1.1" fill="#fff" opacity=".25" />
  </>) },
  wrench: { deg: 36, body: () => (<>
    <rect x="-2.3" y="-4" width="4.6" height="18" rx="2.3" fill="#b9bfc6" />
    <path d="M-2.3 -2 L-2.3 -4.5 A6.8 6.8 0 0 1 -5.8 -14 L-2.6 -11 L2.6 -11 L5.8 -14 A6.8 6.8 0 0 1 2.3 -4.5 L2.3 -2 Z" fill="#b9bfc6" stroke="#8d939a" strokeWidth=".6" />
    <rect x="-1" y="2" width="2" height="9" rx="1" fill="#8d939a" opacity=".6" />
  </>) },
  baton: { deg: 0, body: () => (<>
    <line x1="-10" y1="11" x2="9" y2="-10" stroke="#f4efe6" strokeWidth="1.9" strokeLinecap="round" />
    <circle cx="-9.5" cy="10.5" r="2.8" fill="#6b4a2b" />
    <ellipse cx="7" cy="-15" rx="2.2" ry="1.6" fill="#ffc233" transform="rotate(-20 7 -15)" />
    <path d="M9 -15.3 V -21.5 l 3 1.2" fill="none" stroke="#ffc233" strokeWidth="1.1" />
  </>) },
  telescope: { deg: -28, body: () => (<>
    <rect x="-13" y="-3" width="9" height="6" rx="1.5" fill="#c9a25a" />
    <rect x="-5" y="-3.7" width="9" height="7.4" rx="1.2" fill="#8a5a3b" />
    <rect x="3.5" y="-4.6" width="9" height="9.2" rx="2" fill="#c9a25a" />
    <rect x="11.5" y="-4.6" width="1.6" height="9.2" rx=".8" fill="#cfe9ff" />
    <rect x="-5" y="-3.7" width="9" height="1.6" fill="#fff" opacity=".18" />
  </>) },
  envelope: { deg: -10, body: () => (<>
    <rect x="-12" y="-8" width="24" height="16" rx="2" fill="#f6f1e7" stroke="#cfc6b6" strokeWidth=".8" />
    <path d="M-11.5 -7 L0 1.5 L11.5 -7" fill="none" stroke="#cfc6b6" strokeWidth="1.1" />
    <circle cx="0" cy="1.5" r="2.6" fill="#e2463b" />
  </>) },
  calendar: { deg: -8, body: () => (<>
    <rect x="-10.5" y="-9" width="21" height="20" rx="3" fill="#fff" />
    <path d="M-10.5 -3 V -6 a3 3 0 0 1 3 -3 h15 a3 3 0 0 1 3 3 V -3 Z" fill="#e2463b" />
    <rect x="-6" y="-11.5" width="1.8" height="4.5" rx=".9" fill="#2a2a30" />
    <rect x="4.2" y="-11.5" width="1.8" height="4.5" rx=".9" fill="#2a2a30" />
    <text x="0" y="8" textAnchor="middle" fontFamily={ARIAL} fontWeight="700" fontSize="9.5" fill="#2a2a30">12</text>
  </>) },
  clipboard: { deg: -8, body: () => (<>
    <rect x="-9.5" y="-11" width="19" height="24" rx="2.5" fill="#a87445" />
    <rect x="-7.5" y="-8" width="15" height="18.5" rx="1" fill="#fff" />
    <rect x="-4.5" y="-13" width="9" height="4.5" rx="1.4" fill="#8e949c" />
    {[-4, 1, 6].map((y, i) => (
      <g key={y}>
        <path d={`M-5.5 ${y} l1.4 1.4 l2.6 -2.8`} fill="none" stroke={i < 2 ? '#2fd4a5' : '#cfcfcf'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="0" y={y - 0.6} width="5" height="1.3" rx=".6" fill="#cfcfcf" />
      </g>
    ))}
  </>) },
  hourglass: { deg: -12, body: () => (<>
    <rect x="-8.5" y="-12.5" width="17" height="3" rx="1.4" fill="#8a5a3b" />
    <rect x="-8.5" y="9.5" width="17" height="3" rx="1.4" fill="#8a5a3b" />
    <path d="M-6.5 -9.5 L6.5 -9.5 L1.3 0 L6.5 9.5 L-6.5 9.5 L-1.3 0 Z" fill="#cfe9ff" fillOpacity=".4" stroke="#dfe3e8" strokeWidth=".9" />
    <path d="M-3.8 -5 L3.8 -5 L0 -.8 Z" fill="#ffc233" />
    <path d="M-5.2 9.4 Q0 3, 5.2 9.4 Z" fill="#ffc233" />
    <line x1="0" y1="-.5" x2="0" y2="7" stroke="#ffc233" strokeWidth=".8" />
  </>) },
  teacher: { deg: -14, body: () => (<>
    <rect x="-9" y="-11.5" width="17" height="23" rx="2" fill="#3f6fd8" />
    <rect x="6" y="-10" width="3.2" height="20" rx="1" fill="#f6f1e7" />
    <rect x="-9" y="-11.5" width="3" height="23" rx="1.4" fill="#2f57b0" />
    <rect x="-3.5" y="-5" width="8" height="3.4" rx="1" fill="#ffc233" />
  </>) },
  calculator: { deg: -10, body: () => (<>
    <rect x="-8.5" y="-12" width="17" height="24" rx="2.6" fill="#3a3a42" />
    <rect x="-6.5" y="-9.8" width="13" height="5.4" rx="1.1" fill="#9fe3b0" />
    {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (
      <rect key={`${r}${c}`} x={-6.5 + c * 4.6} y={-2 + r * 4.4} width="3.6" height="3.4" rx=".8" fill={r === 2 && c === 2 ? '#ff8a3d' : '#c9ccd2'} />
    )))}
  </>) },
  chart: { deg: -8, body: () => (<>
    <rect x="-11.5" y="-9.5" width="23" height="19" rx="2.6" fill="#fff" />
    <rect x="-7.5" y="1" width="3.6" height="5.5" rx=".8" fill="#3fa9ff" />
    <rect x="-2" y="-3" width="3.6" height="9.5" rx=".8" fill="#2fd4a5" />
    <rect x="3.5" y="-6.5" width="3.6" height="13" rx=".8" fill="#a35bff" />
    <path d="M-8 -1 L-1 -5 L5 -9" fill="none" stroke="#ff5a4f" strokeWidth="1.2" strokeLinecap="round" />
  </>) },
  brush: { deg: 38, body: () => (<>
    <rect x="-1.7" y="-2" width="3.4" height="17" rx="1.7" fill="#c8763a" />
    <rect x="-2.5" y="-6.5" width="5" height="5.2" rx=".8" fill="#b9bfc6" />
    <path d="M-2.5 -6.5 Q -3.2 -12.5, 0 -16 Q 3.2 -12.5, 2.5 -6.5 Z" fill="#ff5fbf" />
  </>) },
  globe: { deg: 0, body: () => (<>
    <path d="M-11.5 4 A12.5 12.5 0 0 0 5 12" fill="none" stroke="#8a5a3b" strokeWidth="2" strokeLinecap="round" />
    <rect x="-5" y="12" width="10" height="2.6" rx="1.3" fill="#8a5a3b" />
    <circle cx="0" cy="0" r="10" fill="#3fa9ff" />
    <path d="M-6 -6 q4 -2 6 1 q-1 4 -5 3 q-3 2 -4 -1 Z M2 2 q5 -1 6 3 q-2 4 -6 2 Z M1 -9 q3 0 4 2 q-2 1 -4 0 Z" fill="#7bd94a" />
    <ellipse cx="0" cy="0" rx="4.5" ry="10" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".8" />
    <ellipse cx="-3" cy="-4" rx="3" ry="2" fill="#fff" opacity=".18" />
  </>) },
  megaphone: { deg: -14, body: () => (<>
    <path d="M-7.5 -3.2 L 8 -10.5 L 8 10.5 L -7.5 3.2 Z" fill="#ff5a4f" />
    <ellipse cx="8" cy="0" rx="2.4" ry="10.5" fill="#d9443b" />
    <rect x="-11" y="-3.4" width="4" height="6.8" rx="1.2" fill="#2a2a30" />
    <rect x="-4.5" y="3" width="3.2" height="7" rx="1.2" fill="#2a2a30" />
    <path d="M-6 -2 L 7 -8" stroke="#fff" strokeOpacity=".3" strokeWidth="1.2" />
  </>) },
  shield: { deg: -6, body: () => (<>
    <path d="M0 -12.5 L 10.5 -8.5 L 10.5 0 C 10.5 7, 5 11.5, 0 13.5 C -5 11.5, -10.5 7, -10.5 0 L -10.5 -8.5 Z" fill="#3fa9ff" />
    <path d="M0 -10 L 8 -7 L 8 0 C 8 5.5, 4 9, 0 10.8 Z" fill="#fff" opacity=".18" />
    <path d="M-4.5 0 l3.2 3.2 l6 -6.4" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </>) },
  coffee: { deg: 0, body: () => (<>
    <path d="M4.5 -2.5 C 11 -2.5, 11 6, 4.5 6" fill="none" stroke="#f6f1e7" strokeWidth="3" />
    <rect x="-8.5" y="-6" width="13.5" height="15" rx="2.6" fill="#f6f1e7" />
    <ellipse cx="-1.75" cy="-6" rx="6.75" ry="1.7" fill="#6b4a2b" />
    <text x="-1.75" y="4.6" textAnchor="middle" fontFamily={ARIAL} fontWeight="700" fontSize="6" fill="#3fa9ff">{'</>'}</text>
    <path d="M-4.5 -9 q-2 -2.5 0 -5 q2 -2.5 0 -5 M1 -9 q-2 -2.5 0 -5 q2 -2.5 0 -5" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
  </>) },
};

/** The mortarboard, sized from the top of the skull. */
function Mortarboard({ top }: { top: number }): ReactElement {
  const y = Math.max(top, 12.5);
  return (
    <g data-mascot-cap="">
      <path d={`M38 ${y + 3.5} Q 50 ${y + 8}, 62 ${y + 3.5} L 62 ${y - 3} L 38 ${y - 3} Z`} fill="#1f1f24" />
      <path d={`M26 ${y - 4.5} L 50 ${y - 11} L 74 ${y - 4.5} L 50 ${y + 1.5} Z`} fill="#2b2b30" />
      <circle cx="50" cy={y - 4.5} r="1.6" fill="#ffc233" />
      <path d={`M50 ${y - 4.5} L 67 ${y - 2.5} L 67 ${y + 7}`} fill="none" stroke="#ffc233" strokeWidth="1.3" />
      <rect x="65.6" y={y + 6} width="2.8" height="5" rx="1" fill="#ffc233" />
    </g>
  );
}

/** The kept elements as React elements: never markup put in the page as HTML. */
function svgElements(nodes: readonly MascotSvgNode[], path = 'a'): ReactNode[] {
  return nodes.map((node, i) => createElement(node.tag, { ...node.props, key: `${path}${i}` }, ...svgElements(node.children, `${path}${i}.`)));
}

/** Read once per part object: a pack registered again is read again. */
const packArt = new WeakMap<object, ReactNode[] | null>();

/**
 * A pack's tool, as its markup reads. The registry already refused a part it
 * could not read; reading again here is what turns it into elements, and a
 * refusal (which cannot happen for a registered part) draws nothing.
 */
/**
 * The tool alone, centred and enlarged in the 0–100 box: what a configurator
 * cell shows, where the whole head would leave it a few pixels wide.
 */
export function MascotAccessoryIcon({ acc }: { acc: MascotAccessory | MascotPartId }): ReactElement | null {
  if (acc === 'none') return null;
  const tool = (TOOLS as Readonly<Record<string, Tool>>)[acc] ?? packTool(acc);
  if (!tool) return null;
  return <g transform={`translate(50 50) rotate(${tool.deg}) scale(2.4)`}>{tool.body()}</g>;
}

function packTool(acc: string): { deg: number; body: () => ReactNode } | null {
  const part = mascotPartOf('acc', acc);
  if (!part) return null;
  let art = packArt.get(part);
  if (art === undefined) {
    const read = readMascotSvg(part.svg);
    art = read.ok ? svgElements(read.nodes) : null;
    packArt.set(part, art);
  }
  const body = art;
  return body ? { deg: part.tilt ?? 0, body: () => body } : null;
}

/**
 * The accessory of a look, in front of the head. Big by default, spilling
 * past the bottom-right corner (the svg overflows); `fit` keeps it inside the
 * 100×100 box, for a bitmap or a cell that clips. A pack's tool is drawn the
 * same way; one whose pack is gone draws nothing.
 */
export function MascotAccessoryArt({ acc, top, fit }: { acc: MascotAccessory | MascotPartId; top: number; fit: boolean }): ReactElement | null {
  if (acc === 'none') return null;
  const tool = (TOOLS as Readonly<Record<string, Tool>>)[acc] ?? packTool(acc);
  if (!tool) return null;
  const place = fit ? `translate(78 78) rotate(${tool.deg}) scale(1.3)` : `translate(85 85) rotate(${tool.deg}) scale(1.75)`;
  return (
    <>
      {acc === 'teacher' && <Mortarboard top={top} />}
      <g transform={place}>{tool.body()}</g>
    </>
  );
}

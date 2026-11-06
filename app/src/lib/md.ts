/* Minimal markdown renderer and line-diff helpers used by the memory editor. */

export function md2html(src: string): string {
  let s = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/```([\s\S]*?)```/g, (_m, c) => `<pre>${c.replace(/^\n/, '')}</pre>`);
  s = s
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // A thematic break is space, not a drawn rule (AGENTS.md rule 16).
  s = s.replace(/^---$/gm, '<div class="md-break" role="separator"></div>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s
    .replace(/^- \[ \] (.+)$/gm, '<li><input type="checkbox" disabled/>$1</li>')
    .replace(/^- \[x\] (.+)$/gm, '<li><input type="checkbox" disabled checked/>$1</li>');

  const lines = s.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  for (const ln of lines) {
    const ul = /^- (.+)$/.exec(ln);
    const ol = /^\d+\. (.+)$/.exec(ln);
    const li = /^<li>/.test(ln);
    if (ul) {
      if (listType !== 'ul') {
        if (listType) out.push(`</${listType}>`);
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listType !== 'ol') {
        if (listType) out.push(`</${listType}>`);
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${ol[1]}</li>`);
    } else if (li) {
      if (listType !== 'ul') {
        if (listType) out.push(`</${listType}>`);
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(ln);
    } else {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
      out.push(ln);
    }
  }
  if (listType) out.push(`</${listType}>`);
  s = out.join('\n');
  s = s
    .split(/\n{2,}/)
    .map((blk) => {
      if (/^\s*<(h\d|ul|ol|pre|blockquote|hr|p)/.test(blk.trim())) return blk;
      if (!blk.trim()) return '';
      return `<p>${blk.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');
  return s;
}

export type DiffLine = { k: 'ctx' | 'add' | 'rem'; t: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const m = A.length;
  const n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ k: 'ctx', t: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ k: 'rem', t: A[i++]! });
    } else {
      out.push({ k: 'add', t: B[j++]! });
    }
  }
  while (i < m) out.push({ k: 'rem', t: A[i++]! });
  while (j < n) out.push({ k: 'add', t: B[j++]! });
  return out;
}

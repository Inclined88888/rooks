/**
 * A real headline in two lines (the industrial redesign: huge, uppercase, the second line offset). The words never
 * change: the split is at the space nearest the middle by letters, and joining the two halves with one space gives
 * the headline back. One word stays one line (the second half is empty).
 */
export function splitHeadline(text: string): [string, string] {
  const t = text.trim().replace(/\s+/g, " ");
  const words = t.split(" ");
  if (words.length < 2) return [t, ""];
  let best = 1;
  let bestGap = Infinity;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ").length;
    const right = words.slice(i).join(" ").length;
    // ties go to the longer first line, so the offset second line is the shorter one
    const gap = Math.abs(left - right) - (left >= right ? 0.5 : 0);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

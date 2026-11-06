/** A `.md` imported by the bundle is its text (esbuild `--loader:.md=text`). */
declare module '*.md' {
  const text: string;
  export default text;
}

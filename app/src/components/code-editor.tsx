'use client';

/**
 * The code editor of the file preview modal (CodeMirror 6).
 *
 * Why CodeMirror rather than the original `<textarea>`: a textarea colours
 * nothing. The read-only preview (`view` mode) stays HTML highlighted by
 * highlight.js, static, copyable, almost free; only editing pays for the
 * editor, and only when switching to it (dynamic import in chat-client).
 *
 * The theme is not a packaged CodeMirror theme: it reads the same `--hl-*`
 * variables as the chat bubbles and the preview, so the site's light/dark
 * toggle applies with no theme switch to maintain here.
 */

import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';
import { hljsLanguageFor } from '@/lib/file-icons';

const MONO =
  /* code-font: the code editor font */ "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

const novaTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--hl-bg)',
    color: 'var(--hl-fg)',
    fontSize: '12px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  '.cm-content': { caretColor: 'hsl(var(--primary))', padding: '0.75em 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--hl-bg)',
    color: 'var(--hl-comment)',
    border: 'none',
    opacity: 0.55,
    paddingRight: '0.4em',
  },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--primary) / 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', opacity: 1 },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'hsl(var(--primary))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'hsl(var(--primary) / 0.28)',
  },
  '.cm-selectionMatch': { backgroundColor: 'hsl(var(--primary) / 0.14)' },
  '.cm-searchMatch': { backgroundColor: 'hsl(var(--warning) / 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'hsl(var(--warning) / 0.45)' },
  '.cm-panels': {
    backgroundColor: 'hsl(var(--card))',
    color: 'hsl(var(--foreground))',
    borderColor: 'hsl(var(--border))',
  },
  '.cm-panels input, .cm-panels button': {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 'calc(var(--radius) * 0.4)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'hsl(var(--primary) / 0.18)',
    outline: 'none',
  },
});

// The same colour roles as the highlight.js mapping in globals.css, so a file
// does not change palette between `view` and `edit`.
const novaHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.modifier, t.self, t.null], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.literal, t.atom], color: 'var(--hl-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--hl-function)' },
  { tag: [t.propertyName, t.attributeName, t.variableName, t.definition(t.variableName)], color: 'var(--hl-variable)' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: 'var(--hl-type)' },
  { tag: [t.standard(t.variableName), t.tagName, t.operatorKeyword, t.character], color: 'var(--hl-builtin)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--hl-comment)' },
  { tag: t.link, color: 'var(--hl-number)', textDecoration: 'underline' },
  { tag: t.heading, color: 'var(--hl-function)', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.deleted, backgroundColor: 'var(--hl-deletion-bg)' },
  { tag: t.inserted, backgroundColor: 'var(--hl-addition-bg)' },
  { tag: t.invalid, color: 'hsl(var(--destructive))' },
]);

export default function CodeEditor({
  value,
  filename,
  onChange,
}: {
  value: string;
  /** File name (not the path), used to pick the grammar. */
  filename: string;
  onChange: (next: string) => void;
}) {
  // The grammar loads on demand: `@codemirror/language-data` only ships
  // descriptors, each `load()` is a dynamic import. One language enters the
  // bundle per opened file.
  const [langExt, setLangExt] = useState<Extension[]>([]);
  useEffect(() => {
    let cancelled = false;
    // `.env`, `.env.local`, `.npmrc` have no usable extension: fall back on the
    // preview's detection (hljsLanguageFor), whose ids (ini, bash, dockerfile)
    // are CodeMirror aliases.
    const desc =
      LanguageDescription.matchFilename(languages, filename)
      ?? LanguageDescription.matchLanguageName(languages, hljsLanguageFor(filename) ?? '');
    if (!desc) {
      setLangExt([]);
      return;
    }
    void desc.load().then((support) => {
      if (!cancelled) setLangExt([support]);
    });
    return () => { cancelled = true; };
  }, [filename]);

  const extensions = useMemo(
    () => [syntaxHighlighting(novaHighlight), EditorView.lineWrapping, ...langExt],
    [langExt],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={novaTheme}
      extensions={extensions}
      height="100%"
      className="min-h-0 flex-1 overflow-hidden"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        // A general-purpose editor's autocompletion mostly offers noise on a
        // config file; search, on the other hand, is genuinely useful.
        autocompletion: false,
        highlightActiveLine: true,
        searchKeymap: true,
        // Cmd/Ctrl+S is caught by the modal (save): CodeMirror's default
        // shortcut must not swallow it.
        defaultKeymap: true,
      }}
    />
  );
}

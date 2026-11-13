'use client';

import React, { memo, useMemo } from 'react';
import { createStreamingMarkdownRenderer, type StreamingMarkdownBlock } from '@/lib/markdown';
import { t } from '@/lib/i18n';

const Block = memo(function Block({ block }: { block: StreamingMarkdownBlock }) {
  // The scroll host survives table HTML updates as new rows arrive.
  return (
    <div className={block.table ? 'markdown-table-scroll' : undefined}
      tabIndex={block.table ? 0 : undefined}
      role={block.table ? 'region' : undefined}
      aria-label={block.table ? t('chatMarkdown.tableScroll') : undefined}
      dangerouslySetInnerHTML={{ __html: block.html }} />
  );
});

export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const render = useMemo(createStreamingMarkdownRenderer, []);
  const blocks = useMemo(() => render(text), [render, text]);
  return (
    <div className="streaming-markdown">
      {blocks.map((block) => <Block key={block.key} block={block} />)}
      <span className="streaming-caret" aria-hidden="true" />
    </div>
  );
});

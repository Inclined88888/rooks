// Publishes the Markdown export (scripts/export-markdown.mjs) with the site:
// one `.md` per page next to its HTML, `llms.txt` and `llms-full.txt`.
//
// The exporter computes routes on its own, because the desktop package runs it
// without Docusaurus. This plugin holds it to Docusaurus' own routes: a page
// the two disagree on fails the build instead of publishing a dead `.md` link.
import {exportMarkdown, writeExport} from '../scripts/export-markdown.mjs';

// Docusaurus keeps a trailing slash on index pages (`/plugins/api-reference/`)
// even with `trailingSlash: false`; the served URL has none.
const normalise = route => (route.length > 1 ? route.replace(/\/$/, '') : route);

function sidebarOrder(items, permalinkById, out = []) {
  for (const item of items) {
    if (item.type === 'doc' || item.type === 'ref') {
      const route = permalinkById.get(item.id);
      if (route) out.push(route);
    } else if (item.type === 'category') {
      if (item.link?.type === 'doc') {
        const route = permalinkById.get(item.link.id);
        if (route) out.push(route);
      }
      sidebarOrder(item.items ?? [], permalinkById, out);
    }
  }
  return out;
}

export default function markdownExport(context) {
  let docs = [];
  let order = [];
  return {
    name: 'rooks-markdown-export',
    async allContentLoaded({allContent}) {
      const version = allContent['docusaurus-plugin-content-docs']?.default?.loadedVersions?.[0];
      if (!version) throw new Error('markdown-export: the docs plugin produced no content');
      docs = version.docs;
      const permalinkById = new Map(docs.map(doc => [doc.id, normalise(doc.permalink)]));
      order = Object.values(version.sidebars ?? {}).flatMap(items => sidebarOrder(items, permalinkById));
    },
    async postBuild({outDir}) {
      const result = exportMarkdown({order, siteUrl: context.siteConfig.url});
      const ours = new Set(result.pages.map(page => page.route));
      const theirs = new Set(docs.map(doc => normalise(doc.permalink)));
      const missing = [...theirs].filter(route => !ours.has(route));
      const extra = [...ours].filter(route => !theirs.has(route));
      if (missing.length || extra.length) {
        throw new Error(`markdown-export: routes differ from Docusaurus (missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'}); fix routeOf() in scripts/export-markdown.mjs`);
      }
      writeExport(result, outDir);
    },
  };
}

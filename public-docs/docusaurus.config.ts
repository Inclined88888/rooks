import type {Config} from '@docusaurus/types';
import type {Options, ThemeConfig} from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Timon',
  tagline: 'Install Timon. Put agents to work. Build your own plugins.',
  url: 'https://docs.timon-ai.com',
  baseUrl: '/',
  favicon: 'img/icon-192.png',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'throw',
  trailingSlash: false,
  i18n: {defaultLocale: 'en', locales: ['en']},
  presets: [['classic', {
    docs: {path: 'docs', routeBasePath: '/', sidebarPath: './sidebars.ts'},
    blog: false,
    theme: {customCss: './src/css/custom.css'},
  } satisfies Options]],
  // One `.md` per page, llms.txt and llms-full.txt, for AI readers.
  plugins: ['./plugins/markdown-export.mjs'],
  themes: [['@easyops-cn/docusaurus-search-local', {
    hashed: true, language: ['en'], docsRouteBasePath: '/',
    indexBlog: false, indexPages: false, highlightSearchTermsOnTargetPage: true,
    searchBarShortcutHint: true,
  }]],
  themeConfig: {
    navbar: {
      title: 'Timon Docs',
      logo: {alt: 'Timon', src: 'img/logo-black.svg', srcDark: 'img/logo-white.svg'},
      items: [
        {to: '/installation/overview', activeBaseRegex: '^/installation/', label: 'Installation', position: 'left'},
        {to: '/usage/concepts', activeBaseRegex: '^/usage/', label: 'Using Timon', position: 'left'},
        {to: '/plugins/overview', activeBaseRegex: '^/plugins/', label: 'Create a plugin', position: 'left'},
      ],
    },
    colorMode: {respectPrefersColorScheme: true},
    footer: {copyright: `Copyright © ${new Date().getFullYear()} Timon`},
  } satisfies ThemeConfig,
};
export default config;

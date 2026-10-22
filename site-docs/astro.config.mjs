// Kimochi docs: Astro + Starlight, served from docs.kimochiapp.com (see README.md).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'

const SITE = 'https://docs.kimochiapp.com'
const MARKETING = 'https://kimochiapp.com'
const here = (path) => fileURLToPath(new URL(path, import.meta.url))

// Every page's edit link (src/components/EditLink.astro). Built, it opens the page's source in
// GitHub's editor, which forks the repository and offers a pull request for anyone who isn't a
// collaborator. Under `astro dev` it opens the file in Zed (zed://file/<absolute path>), and the
// dev server reloads the page on save.
const DEV = process.argv.includes('dev')
const EDIT_BASE = DEV ? `zed://file${here('.')}` : 'https://github.com/hamstu/kimochi-tauri/edit/main/site-docs/'

export default defineConfig({
  site: SITE,
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  vite: {
    resolve: {
      // The marketing site's tokens.css (../site/src/styles) imports its fonts by package name;
      // resolve them from this project so the docs build without site/node_modules.
      alias: {
        '@fontsource-variable/figtree': here('node_modules/@fontsource-variable/figtree'),
        '@fontsource-variable/noto-sans-jp': here('node_modules/@fontsource-variable/noto-sans-jp'),
        '@fontsource-variable/caveat': here('node_modules/@fontsource-variable/caveat')
      }
    },
    server: { fs: { allow: [here('.'), here('../site/src/styles'), here('../frontend/assets/dictionary-previews'), here('../CHANGELOG.md')] } }
  },
  integrations: [
    starlight({
      title: 'Kimochi Docs',
      description:
        'How to install and use Kimochi, the free desktop app that reads the Japanese in your games with OCR, an overlay, pop-up dictionaries and a reading log.',
      logo: { src: './src/assets/kimochi-icon.svg', alt: 'Kimochi' },
      favicon: '/favicon.svg',
      lastUpdated: false,
      editLink: { baseUrl: EDIT_BASE },
      pagination: true,
      social: [{ icon: 'github', label: 'Kimochi on GitHub', href: 'https://github.com/hamstu/kimochi-tauri' }],
      customCss: ['./src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Hero: './src/components/Hero.astro',
        Footer: './src/components/Footer.astro',
        Head: './src/components/Head.astro',
        EditLink: './src/components/EditLink.astro'
      },
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } }
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            {
              label: 'Installation',
              items: [
                { label: 'Overview', slug: 'install' },
                { label: 'macOS', slug: 'install/macos' },
                { label: 'Windows', slug: 'install/windows' },
                { label: 'Linux', slug: 'install/linux' },
                { label: 'Steam Deck', slug: 'install/steam-deck' }
              ]
            },
            { label: 'Welcome guide', slug: 'welcome-guide' },
            { label: 'Quick start', slug: 'quick-start' }
          ]
        },
        {
          label: 'Reading',
          items: [
            { label: 'Sources and crop', slug: 'reading/sources' },
            { label: 'OCR engines', slug: 'reading/ocr-engines' },
            { label: 'Auto OCR', slug: 'reading/auto-ocr' },
            { label: 'The overlay', slug: 'reading/overlay' },
            { label: 'Mini mode', slug: 'reading/mini-mode' },
            { label: 'Texthookers and clipboard', slug: 'reading/texthookers' }
          ]
        },
        {
          label: 'Lookups and mining',
          items: [
            { label: 'Dictionaries', slug: 'lookups/dictionaries' },
            { label: 'Looking up words', slug: 'lookups/looking-up' },
            { label: 'Anki', slug: 'lookups/anki' },
            { label: 'Translation and AI', slug: 'lookups/translation-and-ai' }
          ]
        },
        {
          label: 'Log and notebook',
          items: [
            { label: 'The Log', slug: 'log/the-log' },
            { label: 'Sessions and stats', slug: 'log/sessions' },
            { label: 'Notebook', slug: 'log/notebook' }
          ]
        },
        {
          label: 'Controller and handheld',
          items: [
            { label: 'Controller', slug: 'controller' },
            { label: 'Gaming Mode', slug: 'controller/gaming-mode' }
          ]
        },
        {
          label: 'Kimochi Cloud',
          items: [
            { label: 'Accounts and plans', slug: 'cloud' },
            { label: 'Sync and backup', slug: 'cloud/sync' }
          ]
        },
        {
          label: 'Reference',
          items: [
            { label: 'Settings', slug: 'reference/settings' },
            { label: 'Keyboard shortcuts', slug: 'reference/shortcuts' },
            { label: 'Controller buttons', slug: 'reference/controller-buttons' },
            { label: 'Files and data', slug: 'reference/data' }
          ]
        },
        {
          label: 'Help',
          items: [
            { label: 'Troubleshooting', slug: 'help/troubleshooting' },
            { label: 'FAQ', slug: 'help/faq' },
            { label: 'Privacy', slug: 'help/privacy' },
            { label: 'Changelog', link: '/changelog/' },
            { label: 'kimochiapp.com', link: MARKETING, attrs: { target: '_self' } }
          ]
        }
      ],
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true, exclude: ['/changelog/'] })]
    })
  ]
})

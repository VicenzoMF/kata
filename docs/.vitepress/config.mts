import { defineConfig } from 'vitepress'

const gh = 'https://github.com/VicenzoMF/kata'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'en-US',
  title: 'Kata',
  titleTemplate: ':title · Kata',
  description:
    'A web framework on Hono — opinionated like NestJS, functional like a script, verifiable like a type system.',
  // GitHub Pages project site: https://vicenzomf.github.io/kata/
  base: '/kata/',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,
  // The old cookbook landing is replaced by cookbook/index.md.
  srcExclude: ['**/_template.md', '**/TASK.md', '**/README.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/kata/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#E34234' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Kata' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Disciplined web APIs on Hono. Functional, schema-complete, verifiable.',
      },
    ],
  ],

  themeConfig: {
    logo: { light: '/enso.svg', dark: '/enso-dark.svg' },
    siteTitle: 'Kata',

    nav: [
      { text: 'Guide', link: '/guide/what-is-kata', activeMatch: '/guide/' },
      { text: 'Cookbook', link: '/cookbook/', activeMatch: '/cookbook/' },
      { text: 'Reference', link: '/reference/', activeMatch: '/reference/' },
      // No index page is possible under docs/adr/ (ADR-0007 makes it immutable),
      // so the ADRs nav lands on the first decision; the sidebar lists them all.
      { text: 'ADRs', link: '/adr/0001-use-hono-as-base', activeMatch: '/adr/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Kata', link: '/guide/what-is-kata' },
            { text: 'Why Kata', link: '/guide/why-kata' },
            { text: 'Quickstart', link: '/guide/quickstart' },
          ],
        },
        {
          text: 'Core concepts',
          items: [
            { text: 'Context & DI', link: '/guide/context-di' },
            { text: 'Routes & schemas', link: '/guide/routes-schemas' },
            { text: 'Services', link: '/guide/services' },
            { text: 'Middleware & scoped slots', link: '/guide/middleware' },
            { text: 'The error envelope', link: '/guide/errors' },
            { text: 'Typed RPC client', link: '/guide/rpc-client' },
            { text: 'Project layout', link: '/guide/project-layout' },
          ],
        },
        {
          text: 'Going to production',
          items: [
            { text: 'App-level middleware', link: '/guide/app-middleware' },
            { text: 'JWT auth', link: '/guide/jwt' },
            { text: 'Lifecycle & shutdown', link: '/guide/lifecycle' },
            { text: 'Bootstrap CLI', link: '/guide/cli' },
            { text: 'Harness engineering', link: '/guide/harness' },
          ],
        },
      ],
      '/cookbook/': [
        {
          text: 'Cookbook',
          items: [
            { text: 'Overview', link: '/cookbook/' },
            { text: 'Auth', link: '/cookbook/auth' },
            { text: 'Database', link: '/cookbook/database' },
            { text: 'Errors', link: '/cookbook/errors' },
            { text: 'Migrating from NestJS', link: '/cookbook/migrating-from-nestjs' },
            { text: 'Non-goals (BYO)', link: '/cookbook/non-goals' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'defineContext', link: '/reference/define-context' },
            { text: 'defineRoute', link: '/reference/define-route' },
            { text: 'defineMiddleware', link: '/reference/define-middleware' },
            { text: 'createApp', link: '/reference/create-app' },
            { text: 'Built-in middleware', link: '/reference/middleware' },
            { text: 'kata/jwt', link: '/reference/jwt' },
          ],
        },
      ],
      '/adr/': [
        {
          text: 'Architecture Decisions',
          items: [
            { text: '0001 · Use Hono as base', link: '/adr/0001-use-hono-as-base' },
            { text: '0002 · No classes, no decorators', link: '/adr/0002-no-classes-no-decorators' },
            { text: '0003 · Mandatory input/output schemas', link: '/adr/0003-mandatory-input-output-schemas' },
            { text: '0004 · DI via scoped slots', link: '/adr/0004-di-via-scoped-slots' },
            { text: '0005 · DTOs in a separate file', link: '/adr/0005-dtos-in-separate-schema-file' },
            { text: '0006 · Issue tracking', link: '/adr/0006-issue-tracking-via-milestones-epics-sub-issues' },
            { text: '0007 · Self-apply the harness', link: '/adr/0007-self-apply-harness-before-feature-work' },
            { text: '0008 · Unified error envelope', link: '/adr/0008-unified-error-response-envelope' },
            { text: '0009 · Output validation mode', link: '/adr/0009-output-validation-mode' },
            { text: '0010 · Ban --no-verify & config tampering', link: '/adr/0010-ban-no-verify-and-config-tampering' },
            { text: '0011 · Multi-status output schemas', link: '/adr/0011-multi-status-output-schemas' },
            { text: '0012 · App-level middleware', link: '/adr/0012-app-level-middleware' },
            { text: '0013 · JWT delivery', link: '/adr/0013-jwt-delivery' },
            { text: '0014 · Lifecycle & shutdown', link: '/adr/0014-lifecycle-shutdown' },
            { text: '0015 · Bootstrap CLI', link: '/adr/0015-bootstrap-cli' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: gh }],
    search: { provider: 'local' },
    editLink: {
      pattern: `${gh}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    lastUpdated: { text: 'Updated', formatOptions: { dateStyle: 'medium' } },
    outline: { level: 'deep', label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Open-source — license TBD. Built on Hono + Zod.',
      copyright: 'Kata · the practiced form',
    },
  },
})

import { defineConfig } from 'vitepress';

export default defineConfig({
    title: 'PixelCI',
    description: 'Self-hosted visual regression testing',
    head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]],

    themeConfig: {
        nav: [
            { text: 'Guide', link: '/getting-started' },
            { text: 'GitHub', link: 'https://github.com/zyno-io/pixelci' }
        ],

        sidebar: [
            {
                text: 'Guide',
                items: [
                    { text: 'Getting Started', link: '/getting-started' },
                    { text: 'Deployment', link: '/deployment' },
                    { text: 'GitLab Setup', link: '/gitlab-setup' },
                    { text: 'GitHub Setup', link: '/github-setup' },
                    { text: 'Usage', link: '/usage' },
                    { text: 'LLM Access (MCP)', link: '/llm-access' }
                ]
            }
        ],

        socialLinks: [{ icon: 'github', link: 'https://github.com/zyno-io/pixelci' }],

        search: {
            provider: 'local'
        }
    }
});

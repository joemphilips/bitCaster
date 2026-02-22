// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	output: 'static',
	site: 'https://joemphilips.github.io',
	base: process.env.BASE_URL ?? '/bitCaster-doc',
	integrations: [
		starlight({
			title: 'bitCaster Docs',
			logo: {
				src: './public/logo.svg',
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/joemphilips/bitCaster',
				},
			],
			customCss: [
				'./src/styles/fonts.css',
				'./src/styles/custom.css',
			],
			sidebar: [
				{
					label: 'User Guide',
					items: [
						{
							label: 'Getting Started',
							autogenerate: { directory: 'user-guide/getting-started' },
						},
						{
							label: 'Markets',
							autogenerate: { directory: 'user-guide/markets' },
						},
						{
							label: 'Portfolio',
							autogenerate: { directory: 'user-guide/portfolio' },
						},
						{
							label: 'Market Creation',
							autogenerate: { directory: 'user-guide/market-creation' },
						},
						{
							label: 'Settings',
							autogenerate: { directory: 'user-guide/settings' },
						},
					],
				},
				{
					label: 'Technical',
					items: [
						{
							label: 'Architecture',
							autogenerate: { directory: 'technical/architecture' },
						},
						{
							label: 'NUT-CTF Protocol',
							autogenerate: { directory: 'technical/nut-ctf' },
						},
						{
							label: 'API',
							autogenerate: { directory: 'technical/api' },
						},
						{
							label: 'DLC Oracle',
							autogenerate: { directory: 'technical/dlc-oracle' },
						},
					],
				},
				{ label: 'FAQ', link: '/faq/' },
			],
		}),
	],
});

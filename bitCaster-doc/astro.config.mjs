// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	output: 'static',
	site: 'https://bitcasterdoc.com',
	base: process.env.BASE_URL || '/',
	// Astro doesn't honor PORT by default — wire it through explicitly so
	// Aspire's AppHost (which passes the allocated port via PORT) lines up
	// with the dashboard's proxy endpoint.
	server: {
		port: parseInt(process.env.PORT || '4321'),
		host: true,
	},
	integrations: [
		starlight({
			title: {
				en: 'bitCaster Docs',
				ja: 'bitCaster ドキュメント',
			},
			defaultLocale: 'root',
			locales: {
				root: {
					label: 'English',
					lang: 'en',
				},
				ja: {
					label: '日本語',
				},
			},
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
					translations: { ja: 'ユーザーガイド' },
					items: [
						{
							label: 'Getting Started',
							translations: { ja: 'はじめに' },
							autogenerate: { directory: 'user-guide/getting-started' },
						},
						{
							label: 'Core Concepts',
							translations: { ja: '基本コンセプト' },
							autogenerate: { directory: 'user-guide/core-concepts' },
						},
					],
				},
				{
					label: 'Technical',
					translations: { ja: '技術ドキュメント' },
					items: [
						{
							label: 'Architecture',
							translations: { ja: 'アーキテクチャ' },
							autogenerate: { directory: 'technical/architecture' },
						},
						{
							label: 'Protocol',
							translations: { ja: 'プロトコル' },
							autogenerate: { directory: 'technical/protocol' },
						},
					],
				},
				{
					label: 'Comparison',
					translations: { ja: '類似プラットフォームとの比較' },
					link: '/comparison/',
				},
				{
					label: 'FAQ',
					translations: { ja: 'よくある質問' },
					link: '/faq/',
				},
			],
		}),
	],
});

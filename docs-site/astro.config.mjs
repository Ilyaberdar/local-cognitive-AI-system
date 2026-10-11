// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

const repo = 'https://github.com/Ilyaberdar/local-cognitive-AI-system';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.local-cognitive.com',
	integrations: [
		starlight({
			title: 'Local Cognitive',
			description: 'A private AI workspace for chats, agents and workflows, with models on your own computer or your own GPU server.',
			logo: { src: './src/assets/logo.png' },
			favicon: '/favicon.png',
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			editLink: { baseUrl: `${repo}/edit/main/docs-site/` },
			customCss: ['./src/styles/theme.css'],
			lastUpdated: true,
			plugins: [starlightLlmsTxt({ projectName: 'Local Cognitive' })],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Overview', slug: '' },
						{ label: 'Install on macOS', slug: 'start/macos' },
						{ label: 'Install on Windows', slug: 'start/windows' },
						{ label: 'First steps', slug: 'start/first-steps' },
					],
				},
				{
					label: 'Your GPU server',
					items: [
						{ label: 'Install the server', slug: 'server/install' },
						{ label: 'Connect a computer', slug: 'server/connect' },
						{ label: 'Server commands', slug: 'server/commands' },
						{ label: 'NVIDIA GPUs', slug: 'server/gpus' },
					],
				},
				{
					label: 'Using Local Cognitive',
					items: [
						{ label: 'Remote', slug: 'guides/remote' },
						{ label: 'Models', slug: 'guides/models' },
						{ label: 'Chats and agents', slug: 'guides/chats' },
						{ label: 'Workflows and tasks', slug: 'guides/workflows' },
						{ label: 'Synthesis', slug: 'guides/synthesis' },
						{ label: 'Synthesis language', slug: 'guides/synthesis-language' },
						{ label: 'MCP and plugins', slug: 'guides/mcp-and-plugins' },
						{ label: 'Voice input', slug: 'guides/voice' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Updates', slug: 'reference/updates' },
						{ label: 'Your data and privacy', slug: 'reference/data' },
						{ label: 'Troubleshooting', slug: 'reference/troubleshooting' },
						{ label: 'Release notes', slug: 'reference/release-notes' },
					],
				},
				{
					label: 'Developers',
					items: [{ label: 'Build from source', slug: 'developers/build' }],
				},
			],
		}),
	],
});

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import federation from '../plugin/vite-plugin-federation';

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		svelte(),
		federation({
			name: 'remote-app',
			filename: 'remoteEntry.js',
			exposes: {
				'./App': './src/App.svelte',
			},
		}),
	],
});

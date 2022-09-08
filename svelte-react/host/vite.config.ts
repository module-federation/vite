import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import federation from '../plugin/vite-plugin-federation';

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		svelte(),
		federation({
			remotes: {
				remote_app: 'http://localhost:4173/assets/remoteEntry.js',
			},
		}),
	],
});

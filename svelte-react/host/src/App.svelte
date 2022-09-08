<script lang="ts">
	// @ts-ignore:
	const load = () => import('remote_app/App');

	load().then((module) => {
		const App = module.default;
		new App({
			target: document.querySelector('body'),
		});
	});
	let count = 0;
</script>

I'm host!

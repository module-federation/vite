<template>
  <div>
    <h1>Nuxt host</h1>

    <p>
      Mode1: <i> {{ runtimeConfig.app.buildId ? ' dev ' : ' prod ' }} mode </i>
    </p>
    <hr />
  </div>
</template>

<script setup>
const runtimeConfig = useRuntimeConfig();

if (process.client) {
  // Load remote app on client side
  import('@namespace/viteViteRemote/App1').then((app) => {
    console.log(app);
  });
}
</script>

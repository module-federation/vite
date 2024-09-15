<template>
  <div>
    <h1>Nuxt host</h1>

    <p>
      Mode: <i> {{ runtimeConfig.app.buildId ? ' dev ' : ' prod ' }} mode </i>
    </p>
    <hr />
  </div>
</template>

<script setup>
const runtimeConfig = useRuntimeConfig();
</script>

<template>
  <p>import 'remoteB/template-only'</p>
  <!-- import { fake } from 'remoteB/html-comment' -->
</template>

<script>
import 'remoteA/module-setup';
</script>

<script setup lang="ts">
import { helper } from 'remoteA/shared/helpers';
defineProps<{ helper: typeof helper }>();
</script>

<style scoped>
/* import 'remoteB/style-comment' */
p::before {
  content: "import 'remoteB/css-string'";
}
</style>

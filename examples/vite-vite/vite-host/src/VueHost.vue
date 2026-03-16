<script setup>
import { defineAsyncComponent, ref } from 'vue';

const VueDemo = defineAsyncComponent(() => import('@namespace/viteViteRemote/VueDemo'));

const text = ref('');
const count = ref(0);
</script>

<template>
  <div class="vue-host">
    <h3>Vue Host Component</h3>

    <div class="hmr-witness">
      <strong>HMR Witness (host Vue state)</strong>
      <p>Type something and click the counter, then edit VueDemo.vue in remote.</p>
      <p>If these values survive — HMR works. If they reset — full reload happened.</p>
      <input v-model="text" placeholder="Type here..." />
      <button @click="count++">Host clicks: {{ count }}</button>
    </div>

    <VueDemo />
  </div>
</template>

<style scoped>
.vue-host {
  width: 1240px;
  background: #35495e;
  color: white;
  padding: 20px;
  border-radius: 8px;
  font-family: sans-serif;
}

.hmr-witness {
  background: rgba(255, 255, 255, 0.15);
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.hmr-witness input {
  padding: 8px;
  margin-right: 8px;
  border-radius: 4px;
  border: none;
}

.hmr-witness button {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  background: #42b883;
  color: white;
  cursor: pointer;
  font-weight: bold;
}
</style>

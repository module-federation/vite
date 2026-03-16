<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <div class="vue-demo">
    <h3>Hello from Vue Remote Component!</h3>
    <p>Try changing this text in VueDemo.vue and watch the host update without reload</p>
    <p>Count: {{ count }}</p>
    <button @click="count++">Increment</button>
  </div>
</template>

<style scoped>
.vue-demo {
  background: #42b883;
  color: white;
  padding: 20px;
  border-radius: 8px;
  font-family: sans-serif;
}

.vue-demo button {
  background: white;
  color: #42b883;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}
</style>

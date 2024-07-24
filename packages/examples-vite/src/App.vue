<script setup>
import _Mfapp01App from "mfapp01/App"
import R from "react"
import _Remote2App from "remote2/App"
import _Button from "remote3/button"
import { applyReactInVue } from "veaury"
import { ref } from 'vue'
const Button = applyReactInVue(_Button)
const Remote2App = applyReactInVue(_Remote2App)
const Mfapp01App = applyReactInVue(_Mfapp01App)

console.log("share vue", ref)
console.log("share React", R)
</script>

<template>
  <div>
    vite vue
    <Button />
    <Remote2App />
    <Mfapp01App />
  </div>
</template>

<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>

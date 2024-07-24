import { createApp, getCurrentInstance} from 'vue'
import {createRouter, createWebHistory} from "vue-router"
import './style.css'
import App from './App.vue'
// import App1 from "remote/App"
import R from "react"
import mfapp01App from "mfapp01/App"
import remote2 from "remote2/App"
import remote3 from "remote3/button"


const rou = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("./components/HelloWorld.vue")
    },
  ]
})

console.log("share vue", createApp)
console.log("share React", R)
console.log("remote1App", mfapp01App)
console.log("remote2", remote2)
console.log("remote3 manifest.json", remote3)

createApp(App).use(rou).mount('#app')
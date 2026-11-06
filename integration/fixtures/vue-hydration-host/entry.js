import { createSSRApp, h, ref } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';

const serverButton = document.querySelector('button');
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { render: () => h('p', 'home') } },
    { path: '/about', component: { render: () => h('p', 'about page') } },
  ],
});
const app = createSSRApp({
  setup() {
    const count = ref(0);
    return () =>
      h('div', [
        h('button', { onClick: () => count.value++ }, `count: ${count.value}`),
        h(
          'a',
          {
            href: '/about',
            onClick: (event) => {
              event.preventDefault();
              router.push('/about');
            },
          },
          'about'
        ),
        h(RouterView),
      ]);
  },
  mounted() {
    window.__hydrationProbe = { reused: serverButton === document.querySelector('button') };
  },
});
app.use(router);
await router.push('/');
await router.isReady();
app.mount('#app');

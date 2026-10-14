import('remote1/Widget')
  .then((widget) => widget.render())
  .then((text) => {
    const app = document.querySelector('#app');
    app.className = 'asset-request-context-widget';
    app.textContent = text;
  });

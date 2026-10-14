// The page sits behind a local dynamic import, like a React.lazy route.
import('./page.js').then((page) => page.render());

// The page sits behind a local dynamic import, like a React.lazy route.
import('./page.ts').then((page) => page.render());

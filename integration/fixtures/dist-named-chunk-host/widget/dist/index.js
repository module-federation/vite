// Stands in for an npm package whose entry is `dist/index.js`: shared by two
// lazy pages, the bundler puts it in a chunk of its own and names it `dist`.
export const label = (name) => `widget:${name}`;

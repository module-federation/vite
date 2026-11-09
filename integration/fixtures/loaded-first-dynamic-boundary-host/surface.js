// An exposed module that lazy-loads a page, like a route table.
export const load = () => import('./page.js');

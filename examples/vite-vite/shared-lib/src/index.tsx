// Reproduces "Duplicated export 'type'" error.
// es-module-lexer parses `export { type Foo }` and reports `type` as a
// separate export name for each inline type specifier → duplicate `type`.
export { type TCardVariant, SharedCounter } from './SharedCounter';
export { type TBadgeColor, formatLabel } from './utils';

// We expect it to be called once (since singleton=true is set).
console.trace('[Shared Lib] Initialized');

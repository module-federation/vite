/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import { Plugin } from "vite";
declare let parsePromise: Promise<unknown>;
export default function (excludeFn: Function): Plugin[];
export { parsePromise };

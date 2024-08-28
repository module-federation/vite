import { Plugin } from "vite";

let _resolve: any, _reject: any, promise = new Promise((resolve, reject) => {
  _resolve = resolve
  _reject = reject
})
let parsePromise = promise

const parseStartSet = new Set()
const parseEndSet = new Set()
export default function (excludeFn: Function): Plugin[] {
  return [
    {
      name: "_",
      apply: "serve",
      config() {
        // No waiting in development mode
        _resolve(1)
      }
    },
    {
      enforce: "pre",
      name: "parseStart",
      apply: "build",
      load(id) {
        if (excludeFn(id)) {
          return
        }
        parseStartSet.add(id)
      }
    },
    {
      enforce: "post",
      name: "parseEnd",
      apply: "build",
      moduleParsed(module) {
        const id = module.id
        if (excludeFn(id)) {
          return
        }
        parseEndSet.add(id)
        if (parseStartSet.size === parseEndSet.size) {
          _resolve(1)
        }
      }
    },
  ]
}
export {
  parsePromise
};


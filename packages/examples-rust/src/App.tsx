import {applyVueInReact} from "veaury"
import App from "viteRemote/App"
const Comp = applyVueInReact(App.default)

export default function Button() {
  return <div>rust host

    <hr />
    <Comp />
  </div>;
}

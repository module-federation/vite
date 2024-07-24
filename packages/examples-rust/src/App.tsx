import {applyVueInReact} from "veaury"
import App from "viteRemote/App"
const AppComponent = App.default

export default function Button() {
  return <div>rust host

    <hr />
    <AppComponent />
  </div>;
}

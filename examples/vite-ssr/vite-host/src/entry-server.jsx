import { renderToString } from 'react-dom/server';
import App from './App';

export async function render() {
  // Resolved through Module Federation: the plugin's SSR entry loader fetches
  // the remote's remoteEntry.ssr.js over HTTP and evaluates it in Node.
  const { default: RemoteWidget } = await import('ssrRemote/Widget');
  return renderToString(<App RemoteWidget={RemoteWidget} />);
}

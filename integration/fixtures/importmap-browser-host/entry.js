import { instance } from 'shared-base';

const { Widget, sharedInstance } = await import('importMapRemote/Widget');

window.__result = {
  rendered: new Widget().render(),
  sameInstance: sharedInstance === instance,
};

import { getInstance } from '@module-federation/runtime';
import { init } from 'mock-shared-dep';

export const render = () => console.log(typeof getInstance, typeof init);

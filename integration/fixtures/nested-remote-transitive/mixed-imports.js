import { helper } from 'remoteA/shared/helpers';

export const eager = helper;
export const lazy = () => import('remoteB/heavy');
export const alsoLazy = () => import('remoteA/shared/helpers');

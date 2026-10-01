// Module-level state: proves host and remote share ONE instance.
export const instance = Symbol('shared-base');

export class Base {
  kind = 'base';
}

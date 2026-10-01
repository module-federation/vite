import { Base } from 'shared-base';

// Top-level extends of a shared class: needs `eager` in MF mode, plain static import here.
export class Widget extends Base {
  render() {
    return `widget:${this.kind}`;
  }
}

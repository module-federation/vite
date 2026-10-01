import { Component } from 'react';

// A top-level `extends` of a shared class. With the MF runtime this needs `eager: true`
// on react; with an import map it is an ordinary static import that is ready before eval.
export default class Button extends Component {
  state = { count: 0 };

  render() {
    return (
      <button type="button" onClick={() => this.setState(({ count }) => ({ count: count + 1 }))}>
        Remote button clicked {this.state.count} times
      </button>
    );
  }
}

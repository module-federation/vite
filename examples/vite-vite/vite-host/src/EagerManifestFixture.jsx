import { Button } from 'antd';
import React from 'react';
import { version as vueVersion } from 'vue';

export default function EagerManifestFixture() {
  return React.createElement(Button, null, `eager manifest fixture ${vueVersion}`);
}

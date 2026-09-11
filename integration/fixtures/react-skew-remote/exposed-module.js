import { useState } from 'react';

export function RemoteComponent() {
  return useState('remote')[0];
}

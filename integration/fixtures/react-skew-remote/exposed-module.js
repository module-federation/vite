import { useState } from 'react';
import 'react-dom/client';

export function RemoteComponent() {
  return useState('remote')[0];
}

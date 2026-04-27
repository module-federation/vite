import { ElementType, useEffect, useState } from 'react';
import { mfRuntime } from '../mfRuntime';

interface DynamicImportProps {
  module: string;
  scope: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadRemoteWithRetry(id: string, retries = 20, delayMs = 500) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await mfRuntime.loadRemote(id);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

export function useDynamicImport({ module, scope }: DynamicImportProps) {
  const [component, setComponent] = useState<ElementType | null>(null);

  useEffect(() => {
    if (!module || !scope) return;

    const loadComponent = async () => {
      try {
        const { default: Component } = (await loadRemoteWithRetry(`${scope}/${module}`)) as {
          default: ElementType;
        };
        setComponent(() => Component);
      } catch (error) {
        console.error(`Error loading remote module ${scope}/${module}:`, error);
      }
    };

    loadComponent();
  }, [module, scope]);

  return component;
}

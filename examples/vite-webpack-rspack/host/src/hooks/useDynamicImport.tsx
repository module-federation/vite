import { loadRemote } from '@module-federation/runtime';
import { ElementType, useEffect, useState } from 'react';

interface DynamicImportProps {
  module: string;
  scope: string;
}

export function useDynamicImport({ module, scope }: DynamicImportProps) {
  const [component, setComponent] = useState<ElementType | null>(null);

  useEffect(() => {
    if (!module || !scope) return;

    const loadComponent = async () => {
      try {
        const { default: Component } = (await loadRemote(`${scope}/${module}`)) as {
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

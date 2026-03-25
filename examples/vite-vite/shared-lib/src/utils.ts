export type TBadgeColor = 'primary' | 'error' | 'warning';

export function formatLabel(text: string) {
  return `[shared-lib] ${text}`;
}

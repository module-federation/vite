import { getSuffix } from '../VirtualModule';

describe('getSuffix', () => {
  it('returns .js for simple package without extension', () => {
    expect(getSuffix('react')).toBe('.js');
  });

  it('returns .js for scoped package without extension', () => {
    expect(getSuffix('@scope/pkg')).toBe('.js');
  });

  it('returns .js for scoped package with dots in namespace but no file', () => {
    expect(getSuffix('@company.name/pkg')).toBe('.js');
  });

  it('detects correct suffix for file with extension', () => {
    expect(getSuffix('some/path/to/module.ts')).toBe('.ts');
  });

  it('detects correct suffix for scoped package with nested file and extension', () => {
    expect(getSuffix('@scope/pkg/sub/file.jsx')).toBe('.jsx');
  });

  it('handles scoped package with dots in namespace and extension in file', () => {
    expect(getSuffix('@company.name/pkg/utils/helper.tsx')).toBe('.tsx');
  });

  it('returns .js if dot is before namespace', () => {
    expect(getSuffix('.bin/@scope/pkg')).toBe('.js');
  });

  it('returns correct suffix when multiple dots after namespace', () => {
    expect(getSuffix('@scope/pkg/path.to/module.name.mjs')).toBe('.mjs');
  });

  it('returns correct suffix for deep relative path with scoped namespace', () => {
    expect(getSuffix('@scope.with.dots/pkg/deep/util.spec.ts')).toBe('.ts');
  });
});

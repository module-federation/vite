import { describe, expect, it } from 'vitest';
import { inlineDeferredPrebuildNamespaceHelper } from '../deferredPrebuildHelper';

const fallbackFile = 'assets/remote__prebuild__vue.js';
const wrapperFile = 'assets/remote__loadShare__vue.js';
const fallbackCode = `var def=Object.defineProperty,helper=(all,noSymbols)=>{
  const namespace={};
  for(const name in all)def(namespace,name,{get:all[name],enumerable:true});
  if(!noSymbols)def(namespace,Symbol.toStringTag,{value:'Module'});
  return namespace;
};
globalThis.localVueEvaluated=true;
export{helper as h};`;

function bundle(wrapperCode: string, runtimeHelper = true) {
  return {
    [fallbackFile]: {
      type: 'chunk' as const,
      fileName: fallbackFile,
      code: fallbackCode,
      modules: runtimeHelper ? { '\0rolldown/runtime.js': {} } : {},
    },
    [wrapperFile]: {
      type: 'chunk' as const,
      fileName: wrapperFile,
      code: wrapperCode,
      imports: [fallbackFile, 'assets/other.js'],
    },
  };
}

describe('deferred prebuild namespace helper', () => {
  it('inlines only the Rolldown helper that creates a static fallback edge', () => {
    const output = bundle(
      `import{h as makeNamespace}from"./remote__prebuild__vue.js";
       import"./other.js";
       const ns=makeNamespace({value:()=>1});
       const fallback=()=>import("./remote__prebuild__vue.js");`
    );
    inlineDeferredPrebuildNamespaceHelper(output);

    expect(output[wrapperFile].code).not.toContain('from"./remote__prebuild__vue.js"');
    expect(output[wrapperFile].code).toContain('const makeNamespace = (all, noSymbols) => {');
    expect(output[wrapperFile].code).toContain('import"./other.js"');
    expect(output[wrapperFile].code).toContain('import("./remote__prebuild__vue.js")');
    expect(output[wrapperFile].imports).toEqual(['assets/other.js']);
  });

  it('leaves eager fallbacks and unrecognized imports intact', () => {
    const eager = bundle(
      'import{h as makeNamespace}from"./remote__prebuild__vue.js";makeNamespace({});'
    );
    inlineDeferredPrebuildNamespaceHelper(eager);
    expect(eager[wrapperFile].code).toContain('from"./remote__prebuild__vue.js"');

    const unknown = bundle(
      'import{h as makeNamespace}from"./remote__prebuild__vue.js";import("./remote__prebuild__vue.js");',
      false
    );
    inlineDeferredPrebuildNamespaceHelper(unknown);
    expect(unknown[wrapperFile].code).toContain('from"./remote__prebuild__vue.js"');
  });

  it('does not rewrite import-like text inside strings or comments', () => {
    const output = bundle(
      `const text='import{h}from"./remote__prebuild__vue.js"';
       // import{h}from"./remote__prebuild__vue.js";
       const fallback=()=>import("./remote__prebuild__vue.js");`
    );
    inlineDeferredPrebuildNamespaceHelper(output);
    expect(output[wrapperFile].code).toContain("const text='import{h}from");
    expect(output[wrapperFile].code).toContain('// import{h}from');
    expect(output[wrapperFile].imports).toEqual([fallbackFile, 'assets/other.js']);
  });

  it('recognizes Vite preloaded fallback imports emitted as template literals', () => {
    const output = bundle(
      'import{h}from"./remote__prebuild__vue.js";const fallback=()=>import(`./remote__prebuild__vue.js`);'
    );
    inlineDeferredPrebuildNamespaceHelper(output);
    expect(output[wrapperFile].code).not.toContain('from"./remote__prebuild__vue.js"');
    expect(output[wrapperFile].imports).toEqual(['assets/other.js']);
  });
});

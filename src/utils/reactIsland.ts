import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NormalizedModuleFederationOptions } from './normalizeModuleFederationOptions';

const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'];

function stripQueryAndHash(id: string) {
  return id.split(/[?#]/, 1)[0];
}

function resolveSourceFile(importPath: string, root: string): string | undefined {
  const cleanImport = stripQueryAndHash(importPath);
  if (!cleanImport.startsWith('.') && !path.isAbsolute(cleanImport)) return;

  const candidate = path.isAbsolute(cleanImport) ? cleanImport : path.resolve(root, cleanImport);
  const candidates = [
    candidate,
    ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(candidate, `index${extension}`)),
  ];
  return candidates.find((filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
}

function localDefaultReexport(source: string): string | undefined {
  const match = source.match(
    /export\s*{\s*(?:default(?:\s+as\s+default)?|[A-Za-z_$][\w$]*\s+as\s+default)\s*}\s*from\s*["']([^"']+)["']/
  );
  return match?.[1]?.startsWith('.') ? match[1] : undefined;
}

export function isReactComponentSource(source: string, filePath = 'component.tsx'): boolean {
  const hasDefaultExport =
    /\bexport\s+default\b/.test(source) ||
    /\bexport\s*{[^}]*\bdefault\b[^}]*}(?:\s*from\s*["'][^"']+["'])?/.test(source);
  if (!hasDefaultExport) return false;

  const extension = path.extname(stripQueryAndHash(filePath)).toLowerCase();
  const canContainJsx = extension === '.tsx' || extension === '.jsx';
  const hasJsx = /<>|<\s*[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\s*\/?>/.test(source);
  const importsReact = /\bfrom\s*["']react["']|\brequire\(\s*["']react["']\s*\)/.test(source);
  const usesReactApi = /\b(?:React\.)?(?:createElement|jsx|jsxs)\s*\(/.test(source);
  const isClientModule = /^\s*["']use client["']\s*;?/m.test(source);

  return (canContainJsx && hasJsx) || (importsReact && (hasJsx || usesReactApi || isClientModule));
}

function isReactComponentFile(filePath: string, seen = new Set<string>()): boolean {
  const normalizedPath = path.resolve(filePath);
  if (seen.has(normalizedPath)) return false;
  seen.add(normalizedPath);

  let source: string;
  try {
    source = fs.readFileSync(normalizedPath, 'utf8');
  } catch {
    return false;
  }
  if (isReactComponentSource(source, normalizedPath)) return true;

  const reexport = localDefaultReexport(source);
  if (!reexport) return false;
  const reexportPath = resolveSourceFile(reexport, path.dirname(normalizedPath));
  return reexportPath ? isReactComponentFile(reexportPath, seen) : false;
}

/**
 * React is shared by the normal MF runtime when explicitly configured. When it
 * is local, UI exposes can safely advertise an island capability in addition
 * to their unchanged default export.
 */
export function getReactIslandExposes(
  options: Pick<NormalizedModuleFederationOptions, 'experiments' | 'exposes' | 'shared'>,
  root: string
): ReadonlySet<string> {
  if (options.experiments.ssrMode !== 'ISLAND') return new Set();
  if (Object.prototype.hasOwnProperty.call(options.shared, 'react')) return new Set();

  const islandExposes = new Set<string>();
  for (const [key, expose] of Object.entries(options.exposes)) {
    const sourceFile = resolveSourceFile(expose.import, root);
    if (sourceFile && isReactComponentFile(sourceFile)) islandExposes.add(key);
  }
  return islandExposes;
}

export function generateReactIslandBrowserDefinition(enabled: boolean): string {
  if (!enabled) return '';

  return `
          exportModule.__mf_island = {
            version: 1,
            renderToHtml() {
              return Promise.reject(new Error("[Module Federation] renderToHtml is only available in the SSR remote entry"));
            },
            hydrate(element, props) {
              const root = element && element.hasAttribute && element.hasAttribute("data-mf-island-state")
                ? element
                : element && element.querySelector
                  ? element.querySelector("[data-mf-island-state]") || element
                  : element;
              if (!root) {
                return Promise.reject(new Error("[Module Federation] Cannot hydrate an island without a root element"));
              }
              let serverProps = {};
              const encodedState = root.getAttribute && root.getAttribute("data-mf-island-state");
              if (encodedState) {
                try {
                  serverProps = JSON.parse(decodeURIComponent(encodedState));
                } catch {
                  serverProps = {};
                }
              }
              const finalProps = Object.assign({}, serverProps, props || {});
              return Promise.all([import("react"), import("react-dom/client")]).then(([React, ReactDOMClient]) => {
                if (typeof ReactDOMClient.hydrateRoot !== "function") {
                  throw new Error("[Module Federation] react-dom/client does not provide hydrateRoot");
                }
                return ReactDOMClient.hydrateRoot(
                  root,
                  React.createElement(importModule.default, finalProps)
                );
              });
            }
          }`;
}

export function generateReactIslandSSRDefinition(enabled: boolean): string {
  if (!enabled) return '';

  return `
          exportModule.__mf_island = {
            version: 1,
            async renderToHtml(props) {
              if (typeof importModule.default !== "function" && typeof importModule.default !== "object") {
                throw new Error("[Module Federation] A React island expose must have a default component export");
              }
              const loadedProps = typeof importModule.load === "function" ? await importModule.load() : {};
              const finalProps = Object.assign({}, loadedProps || {}, props || {});
              const [React, ReactDOMServer] = await Promise.all([
                import("react"),
                import("react-dom/server")
              ]);
              const body = ReactDOMServer.renderToString(
                React.createElement(importModule.default, finalProps)
              );
              const state = encodeURIComponent(JSON.stringify(finalProps));
              return '<div data-mf-island-state="' + state + '">' + body + '</div>';
            },
            hydrate() {
              return Promise.reject(new Error("[Module Federation] hydrate is only available in the browser remote entry"));
            }
          }`;
}

export const REACT_ISLAND_IMPORT_QUERY = 'mf-island';
export const REACT_ISLAND_CLIENT_ID_PREFIX = 'virtual:mf-react-island-client:';
export const REACT_ISLAND_SERVER_ID_PREFIX = 'virtual:mf-react-island-server:';

const RESOLVED_REACT_ISLAND_CLIENT_ID_PREFIX = `\0${REACT_ISLAND_CLIENT_ID_PREFIX}`;
const RESOLVED_REACT_ISLAND_SERVER_ID_PREFIX = `\0${REACT_ISLAND_SERVER_ID_PREFIX}`;

function encodeIslandRemoteId(remoteId: string) {
  return encodeURIComponent(remoteId);
}

function decodeIslandRemoteId(encodedRemoteId: string) {
  return decodeURIComponent(encodedRemoteId);
}

export function getReactIslandImportRemoteId(source: string): string | undefined {
  const queryIndex = source.indexOf('?');
  if (queryIndex === -1) return;

  const query = new URLSearchParams(source.slice(queryIndex + 1));
  if (!query.has(REACT_ISLAND_IMPORT_QUERY)) return;
  return source.slice(0, queryIndex);
}

export function getReactIslandServerImportId(remoteId: string) {
  return `${REACT_ISLAND_SERVER_ID_PREFIX}${encodeIslandRemoteId(remoteId)}`;
}

export function getReactIslandClientImportId(remoteId: string) {
  return `${REACT_ISLAND_CLIENT_ID_PREFIX}${encodeIslandRemoteId(remoteId)}`;
}

export function resolveReactIslandConsumerId(id: string): string | undefined {
  if (id.startsWith(REACT_ISLAND_SERVER_ID_PREFIX)) return `\0${id}`;
  if (id.startsWith(REACT_ISLAND_CLIENT_ID_PREFIX)) return `\0${id}`;
}

function remoteIdFromResolvedIslandId(id: string, prefix: string) {
  if (!id.startsWith(prefix)) return;
  return decodeIslandRemoteId(id.slice(prefix.length));
}

/** Generates the server half of the opt-in `?mf-island` consumer component. */
export function generateReactIslandConsumerServer(remoteId: string): string {
  const source = JSON.stringify(remoteId);
  const clientSource = JSON.stringify(getReactIslandClientImportId(remoteId));
  return `import * as React from "react";
import IslandClient from ${clientSource};

const islandModulePromise = import(${source});

async function loadIslandModule() {
  const namespace = await islandModulePromise;
  const pending = namespace && namespace.__mf_remote_pending;
  if (pending && typeof pending.then === "function") return pending;
  return namespace && namespace.__moduleExports || namespace;
}

export default async function ModuleFederationIsland(props) {
  const remoteModule = await loadIslandModule();
  const shell = remoteModule && remoteModule.__mf_island;
  if (!shell || typeof shell.renderToHtml !== "function") {
    throw new Error(${JSON.stringify(
      `[Module Federation] ${remoteId} does not expose an SSR island capability`
    )});
  }
  const html = await shell.renderToHtml(props);
  return React.createElement(IslandClient, { html, islandProps: props });
}`;
}

/** Generates the client boundary which hydrates with the remote-owned React. */
export function generateReactIslandConsumerClient(remoteId: string): string {
  const source = JSON.stringify(remoteId);
  return `"use client";

import * as React from "react";

const islandModulePromise = import(${source});

async function loadIslandModule() {
  const namespace = await islandModulePromise;
  const pending = namespace && namespace.__mf_remote_pending;
  if (pending && typeof pending.then === "function") return pending;
  return namespace && namespace.__moduleExports || namespace;
}

export default function ModuleFederationIslandClient({ html, islandProps }) {
  const ref = React.useRef(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    void loadIslandModule().then((remoteModule) => {
      const shell = remoteModule && remoteModule.__mf_island;
      if (!shell || typeof shell.hydrate !== "function") {
        throw new Error(${JSON.stringify(
          `[Module Federation] ${remoteId} does not expose a client island capability`
        )});
      }
      return shell.hydrate(element, islandProps);
    });
  }, []);

  return React.createElement("div", {
    ref,
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: html },
  });
}`;
}

export function loadReactIslandConsumerModule(id: string): string | undefined {
  const serverRemoteId = remoteIdFromResolvedIslandId(id, RESOLVED_REACT_ISLAND_SERVER_ID_PREFIX);
  if (serverRemoteId !== undefined) return generateReactIslandConsumerServer(serverRemoteId);

  const clientRemoteId = remoteIdFromResolvedIslandId(id, RESOLVED_REACT_ISLAND_CLIENT_ID_PREFIX);
  if (clientRemoteId !== undefined) return generateReactIslandConsumerClient(clientRemoteId);
}

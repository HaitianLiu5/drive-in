// Module resolution hooks, registered by plugins.js before the first plugin
// is imported. A plugin lists host packages such as @useyolo/plugin-api as
// peerDependencies and does not install its own copy, the way pi provides its
// packages to extensions: this maps those imports to the host's copy, so a
// plugin installed anywhere loads and shares the node's YoloError class.

let provided = {};

export function initialize(data) {
  provided = data?.provided ?? {};
}

export async function resolve(specifier, context, nextResolve) {
  const url = provided[specifier];
  return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
}

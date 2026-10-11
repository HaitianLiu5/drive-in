// Module resolution hook, registered by plugins.js before the first plugin is
// imported. A plugin lists host packages such as @useyolo/plugin-api as
// peerDependencies and does not install its own copy, the way pi provides its
// packages to extensions: this maps those imports to the host's copy, so a
// plugin installed anywhere loads and shares the node's YoloError class.

// `provided` maps package names to the host's module URLs.
export function createResolve(provided) {
  return (specifier, context, nextResolve) => {
    const url = provided[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  };
}

// For module.register() on Node versions without module.registerHooks().
let resolveProvided = createResolve({});

export function initialize(data) {
  resolveProvided = createResolve(data?.provided ?? {});
}

export function resolve(specifier, context, nextResolve) {
  return resolveProvided(specifier, context, nextResolve);
}

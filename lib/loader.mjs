export function resolve(specifier, context, nextResolve) {
  if (specifier === "zet-cli") {
    return {
      url: new URL("./index.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

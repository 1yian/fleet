// Module boundaries. cardd, the extension, and the board share only the wire
// protocol. End-to-end tests drive real processes, so they may import only the
// protocol.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "no-unresolvable", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "protocol-is-a-leaf",
      severity: "error",
      from: { path: "^packages/protocol/" },
      to: { path: "^packages/", pathNot: "^packages/protocol/" },
    },
    {
      name: "packages-share-only-the-protocol",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: { path: "^packages/", pathNot: "^packages/($1|protocol)/" },
    },
    {
      name: "e2e-only-through-processes",
      severity: "error",
      from: { path: "^e2e/" },
      to: { path: "^packages/", pathNot: "^packages/protocol/" },
    },
    {
      name: "src-not-to-dev-dependencies",
      severity: "error",
      from: { path: "^packages/[^/]+/src/" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    includeOnly: "^(packages|e2e)/",
    exclude: { path: "(^|/)(node_modules|dist)/" },
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] },
  },
};

// Drizzle supports many drivers; this application only uses libSQL. pnpm 11
// otherwise retains old optional peer bindings after the direct drivers go away.
const obsoleteDrivers = ["pg", "@types/pg", "@electric-sql/pglite", "@upstash/redis"];

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "drizzle-orm") {
        for (const name of obsoleteDrivers) {
          if (pkg.peerDependencies) delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
          if (pkg.optionalDependencies) delete pkg.optionalDependencies[name];
        }
      }
      return pkg;
    },
  },
};

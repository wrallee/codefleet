# Graph Report - codefleet  (2026-09-22)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 59 nodes · 76 edges · 10 communities (6 shown, 4 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `112004f6`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 11 edges
2. `openRegistry()` - 5 edges
3. `scripts` - 5 edges
4. `start()` - 4 edges
5. `listen()` - 4 edges
6. `createServer()` - 3 edges
7. `close()` - 3 edges
8. `loadEnvironment()` - 3 edges
9. `Registry` - 2 edges
10. `waitForListening()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `start()` --calls--> `openRegistry()`  [EXTRACTED]
  src/server.ts → src/registry/database.ts

## Import Cycles
- None detected.

## Communities (10 total, 4 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.15
Nodes (12): description, devDependencies, @types/node, typescript, engines, node, name, private (+4 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (12): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 2 - "Community 2"
Cohesion: 0.27
Nodes (9): ref_node_events, ref_node_http, ref_node_url, openRegistry(), createServer(), start(), close(), listen() (+1 more)

### Community 3 - "Community 3"
Cohesion: 0.38
Nodes (5): ref_node_fs, ref_node_os, ref_node_path, ref_node_sqlite, Registry

### Community 4 - "Community 4"
Cohesion: 0.40
Nodes (5): scripts, check, start, test, typecheck

### Community 5 - "Community 5"
Cohesion: 0.50
Nodes (3): ref_node_assert, ref_node_test, loadEnvironment()

## Knowledge Gaps
- **25 isolated node(s):** `description`, `@types/node`, `typescript`, `node`, `name` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 33 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `scripts` connect `Community 4` to `Community 0`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `description`, `@types/node`, `typescript` to the rest of the system?**
  _25 weakly-connected nodes found - possible documentation gaps or missing edges._
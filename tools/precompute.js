// Precompute the empty-board analysis so the app opens with exact statistics
// instead of a multi-minute count on the phone. Re-run whenever the puzzle changes:
//   node tools/precompute.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");
const KEEP = 300;

let out = null;
const ctx = { self: { postMessage: m => { if (m.type === "done") out = m; } },
              Date, Uint32Array, Math, Map, Set, Array, Error };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "src/solver.js"), "utf8") + "\n" +
                fs.readFileSync(path.join(root, "src/worker.js"), "utf8"), ctx);

const doc = JSON.parse(fs.readFileSync(path.join(root, "src/puzzle.json"), "utf8"));
ctx.self.onmessage({ data: { type: "init", doc } });
ctx.self.onmessage({ data: { type: "analyze", id: 0, given: [], keep: KEEP } });

// fingerprint ties the cache to this exact board + piece set; the app ignores
// the cache if the puzzle is ever swapped out
const fingerprint = JSON.stringify([doc.board, doc.pieces.map(p => [p.id, p.cells, p.allowFlip])]);
const result = { fingerprint, count: out.count, nodes: out.nodes, ms: out.ms,
                 use: Array.from(out.use), solutions: out.solutions };
fs.writeFileSync(path.join(root, "src/empty-analysis.json"), JSON.stringify(result));
console.log(`empty board: ${out.count} completions, ${out.nodes} nodes, ${out.ms} ms, kept ${out.solutions.length}`);

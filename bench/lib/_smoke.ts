// Quick smoke test for mega-corpus discovery. Run with: npx tsx bench/lib/_smoke.ts
import { discoverMegaCorpus, MEGA_CORPUS_ROOTS, totalLines, totalBytes } from "./corpus.js";

const docs = discoverMegaCorpus();
console.log("Roots tried:");
for (const r of MEGA_CORPUS_ROOTS) console.log("  " + r);
console.log("\nTotal docs:", docs.length);
console.log("Total lines:", totalLines(docs));
console.log("Total KB:", (totalBytes(docs) / 1024).toFixed(0));
const projects = new Map<string, number>();
for (const d of docs) {
  const p = d.rel.split("/")[0];
  projects.set(p, (projects.get(p) ?? 0) + 1);
}
console.log("\nPer project:");
for (const [p, n] of projects) console.log(`  ${p}: ${n} files`);

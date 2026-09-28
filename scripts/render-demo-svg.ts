/**
 * Renders docs/assets/timeout-after-write.svg from a real run of the demo — the image is the
 * demo's actual output, not hand-typed. Refuses to render if the demo's proof fails.
 *
 *   npm run demo:svg
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderDemo, runDemo, verifyProof } from "../examples/timeout-after-write/demo";
import type { Formatter } from "../examples/timeout-after-write/demo";

const OUT = join(__dirname, "..", "docs", "assets", "timeout-after-write.svg");

// Styles are marked with control characters first so the text can be XML-escaped safely, then
// the markers become <tspan>s.
const mark = (cls: string) => (s: string) => `\u0001${cls}\u0002${s}\u0003`;
const svgFormat: Formatter = { bold: mark("b"), dim: mark("d"), red: mark("r"), green: mark("g") };

function toSvgText(line: string): string {
  const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\u0001(\w)\u0002/g, '<tspan class="$1">').replace(/\u0003/g, "</tspan>");
}

const visibleLength = (line: string) => line.replace(/\u0001\w\u0002|\u0003/g, "").length;

async function main(): Promise<void> {
  const result = await runDemo();
  const failures = verifyProof(result);
  if (failures.length > 0) {
    throw new Error(`demo proof failed, not rendering:\n${failures.join("\n")}`);
  }
  const lines = ["$ npm run demo", "", ...renderDemo(result, svgFormat)];

  const fontSize = 14;
  const lineHeight = 21;
  const charWidth = 8.43; // monospace advance at 14px
  const padX = 24;
  const top = 52;
  const width = Math.ceil(Math.max(...lines.map(visibleLength)) * charWidth + padX * 2);
  const height = top + lines.length * lineHeight + 24;

  // Reveal lines one by one, hold, then loop. Blank lines take no time.
  const cycle = 18;
  const step = 0.55;
  let t = 0.4;
  const rows = lines.map((line, i) => {
    const appearAt = t;
    if (line.trim() !== "") t += i === 0 ? 1.0 : step;
    const start = ((appearAt / cycle) * 100).toFixed(2);
    const y = top + i * lineHeight;
    return {
      keyframes: `@keyframes l${i}{0%,${start}%{opacity:0}${(Number(start) + 0.5).toFixed(2)}%,96%{opacity:1}100%{opacity:0}}`,
      text: `<text x="${padX}" y="${y}" style="animation:l${i} ${cycle}s linear infinite">${toSvgText(line)}</text>`
    };
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="corrobo demo: after a lost response the naive retry credits the account twice; corrobo checks the ledger and credits once">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${fontSize}px;fill:#e6e6e6;white-space:pre;opacity:0}
.b{font-weight:700;fill:#ffffff}.d{fill:#8b949e}.r{fill:#ff7b72}.g{fill:#56d364}
${rows.map((r) => r.keyframes).join("\n")}
@media (prefers-reduced-motion:reduce){text{animation:none!important;opacity:1}}
</style>
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
${rows.map((r) => r.text).join("\n")}
</svg>
`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, svg);
  console.log(`wrote ${OUT} (${width}x${height}, ${lines.length} lines)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

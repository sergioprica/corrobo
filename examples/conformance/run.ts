/**
 * Runs corrobo's conformance harness against a correct contract, then against one whose
 * in-flight window is shorter than how late the fake ledger can land a dropped request.
 *
 *   npm run conformance
 */
import { formatConformanceReport, verifyEffectContract } from "corrobo/testing";
import { correctContract, fakeLedger } from "./fake-ledger";

async function main() {
  const good = fakeLedger(500);
  const passing = await verifyEffectContract({
    contract: correctContract(good.client, 1_000),
    target: good.target,
    intent: { amount: 5 },
    otherIntent: { amount: 500 }
  });
  console.log(formatConformanceReport(passing));

  console.log("\n--- same contract, but the ledger can land a dropped request up to 2s late ---\n");
  const slow = fakeLedger(2_000);
  const failing = await verifyEffectContract({ contract: correctContract(slow.client, 1_000), target: slow.target, intent: { amount: 5 } });
  console.log(formatConformanceReport(failing));

  if (!passing.passed || failing.passed) process.exitCode = 1; // the demo must show one pass and one fail
}

main();

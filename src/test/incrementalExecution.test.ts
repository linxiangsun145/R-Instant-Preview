import { strict as assert } from "node:assert";
import { IncrementalExecutionManager } from "../util/incrementalExecution";

function runTests(): void {
  const manager = new IncrementalExecutionManager();

  const codeV1 = [
    "x <- 1",
    "y <- x + 1",
    "y"
  ].join("\n");

  const first = manager.createPlan("scope-a", codeV1);
  assert.equal(first.totalBlocks, 3, "first plan should detect 3 blocks");
  assert.equal(first.executeBlockCount, 3, "first plan should execute all blocks on cold start");
  assert.equal(first.reason, "cold-start", "first plan should be marked as cold-start");
  manager.commitPlan(first);

  const second = manager.createPlan("scope-a", codeV1);
  assert.equal(second.executeBlockCount, 1, "unchanged code should execute only final preview block");
  assert.equal(second.reusedBlockCount, 2, "unchanged code should reuse prior state for non-final blocks");
  manager.commitPlan(second);

  const codeV2 = [
    "x <- 2",
    "y <- x + 1",
    "y"
  ].join("\n");

  const third = manager.createPlan("scope-a", codeV2);
  assert.equal(third.executeBlockCount, 3, "upstream change should mark downstream blocks dirty");
  manager.commitPlan(third);

  const codeV3 = [
    "x <- 2",
    "y <- x + 1",
    "z <- y + 10",
    "z"
  ].join("\n");

  const fourth = manager.createPlan("scope-a", codeV3);
  assert.equal(fourth.reason, "shape-changed", "block count change should be detected as shape change");
  assert.ok(fourth.executeBlockCount >= 2, "shape change should execute at least changed region and final block");

  console.log("incrementalExecution tests passed");
}

runTests();

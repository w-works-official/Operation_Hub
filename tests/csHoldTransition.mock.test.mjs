import assert from "node:assert/strict";
import { inspectionHoldCsAction } from "../src/domain/csHoldTransition.mjs";

// Kim Dasong regression: releasing a hold while one shortage remains must not
// exclude the automatic CS case. Re-applying the hold restores a case that an
// older frontend may already have excluded.
assert.equal(inspectionHoldCsAction({ holdWasOn: true, openShortageCount: 1 }), "retain");
assert.equal(inspectionHoldCsAction({ holdWasOn: false, openShortageCount: 1 }), "reopen");

// The normal completed workflow is unchanged.
assert.equal(inspectionHoldCsAction({ holdWasOn: true, openShortageCount: 0 }), "exclude");
assert.equal(inspectionHoldCsAction({ holdWasOn: false, openShortageCount: 0 }), "none");

console.log("Inspection hold CS transition regression: passed");

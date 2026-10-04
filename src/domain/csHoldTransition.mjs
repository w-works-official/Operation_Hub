export function inspectionHoldCsAction({ holdWasOn = false, openShortageCount = 0 } = {}) {
  const hasOpenShortage = Number(openShortageCount) > 0;
  if (holdWasOn) return hasOpenShortage ? "retain" : "exclude";
  return hasOpenShortage ? "reopen" : "none";
}

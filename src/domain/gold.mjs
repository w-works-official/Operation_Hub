export function isGoldOwnCode(ownCode) {
  const normalized = String(ownCode ?? "").trim().toUpperCase();
  return normalized.includes("GPA") || normalized.includes("GPB");
}

export function isBareGpaOwnCode(ownCode) {
  return String(ownCode ?? "").trim().toUpperCase() === "[GPA]";
}

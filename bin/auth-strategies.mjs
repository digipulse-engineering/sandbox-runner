export const authStrategies = new Map([
  ["api-key-only", ["api-key"]],
  ["api-key-first-then-subscription", ["api-key", "subscription"]],
  ["subscription-only", ["subscription"]],
  ["subscription-first-then-api-key", ["subscription", "api-key"]],
]);

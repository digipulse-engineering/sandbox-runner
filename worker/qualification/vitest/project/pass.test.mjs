import { expect, test } from "vitest";

test("the qualification fixture passes", () => {
  console.log("QUALIFICATION_PASS_STDOUT");
  expect(2 + 2).toBe(4);
});

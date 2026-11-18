import { expect, test } from "vitest";

test("the qualification fixture reports a failed assertion", () => {
  console.log("QUALIFICATION_FAIL_STDOUT");
  expect("QUALIFICATION_ACTUAL").toBe("QUALIFICATION_EXPECTED");
});

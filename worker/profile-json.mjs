// Call after JSON.parse. In valid JSON, a string followed by a colon is an
// object key. Scanning complete strings keeps braces inside them inert.
export function hasDuplicateJsonKeys(text) {
  const objects = [];
  const tokens = /("(?:[^"\\]|\\[\s\S])*")([ \t\n\r]*:)?|[{}]/gu;
  for (const [token, key, colon] of text.matchAll(tokens)) {
    if (token === "{") objects.push(new Set());
    else if (token === "}") objects.pop();
    else if (colon !== undefined) {
      const name = JSON.parse(key);
      const names = objects.at(-1);
      if (names.has(name)) return true;
      names.add(name);
    }
  }
  return false;
}

// plugins#461: the chat is read once and its ids made without joining a
// long message into new strings. What goes to WorkBuddy is what 0.1.43
// sent, byte for byte: testdata/sent-0.1.43.json is testdata/sent.mjs run
// against 0.1.43's index.mjs (the npm tarball's), each body by its sha256
// and each derived id by which requests share it. Every fetch is a fake.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as mod from "./index.mjs"
import { sentBy } from "./testdata/sent.mjs"

const was = JSON.parse(readFileSync(new URL("./testdata/sent-0.1.43.json", import.meta.url), "utf8"))

test("every chat goes as 0.1.43 sent it, retries and the free-only switch included", async () => {
  // in this order: the second run meets what the first taught the plugin
  // (a model that wants the reply after tools, a refused system prompt)
  expect(await sentBy(mod, false)).toEqual(was.off)
  expect(await sentBy(mod, true)).toEqual(was.freeOnly)
})

test("an id made of pieces is the id of the pieces joined, a surrogate pair split between them too", () => {
  const { idFor } = mod._internal
  const smile = "🙂"
  for (const pieces of [["first:", "a", "[image_url:0123abcd]"], ["x" + smile[0], smile[1] + "y"], ["lone" + smile[0]], [smile[0], smile[0], smile[1]], ["", "u3:", "é中"]]) {
    expect(idFor("turn", pieces)).toBe(idFor("turn", pieces.join("")))
  }
  expect(idFor("turn", ["a"])).not.toBe(idFor("conversation", ["a"]))
})

import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ON_HOST } from "../src/runtime/chatOperations";
import { place, Place, setHostPlace } from "../src/runtime/hostPlace";
import { PROJECT_ON_HOST } from "../src/runtime/projectOperations";
import { publicError } from "../src/runtime/publicError";

test("what devices are told names the server, or the computer that hosts them, at the moment it is said", () => {
  assert.equal(CHAT_ON_HOST(), "This chat has full access on the server, so it can only be used or changed there.");
  setHostPlace("MacBook");
  try {
    assert.deepEqual([place(), Place()], ["MacBook", "MacBook"]);
    assert.equal(CHAT_ON_HOST(), "This chat has full access on MacBook, so it can only be used or changed there.");
    assert.equal(PROJECT_ON_HOST(), "This project's folder was chosen on MacBook, so its chats can only be used there.");
    assert.equal(publicError(""), "The operation failed on MacBook.", "an error with nothing to show");
  } finally { setHostPlace(undefined); }
  assert.deepEqual([place(), Place()], ["the server", "The server"]);
  assert.equal(publicError(""), "The operation failed on the server.");
});

import assert from "node:assert/strict";
import test from "node:test";
import { pathScrubber } from "../src/runtime/orchestrationDto";

test("a Windows host's folders are hidden however a model writes them: either slash, without the drive, in any case", () => {
  const scrub = pathScrubber([["C:\\Users\\PC\\data\\projects\\site", "<workspace>"], ["C:\\Users\\PC\\data", "<server>"]]);
  assert.deepEqual(scrub({
    // A task's model on a Windows PC read the project folder as a Mac path (2026-10-31).
    read: "file.read | /Users/PC/data/projects/site/",
    exact: "C:\\Users\\PC\\data\\projects\\site\\hello.txt",
    mixed: "c:/users/pc/DATA/logs and C:\\Users\\PC\\data",
    other: "C:\\Users\\PC\\data-other and C:\\Users\\PC\\database",
    drive: "D:\\Users\\PC\\data\\x"
  }), {
    read: "file.read | <workspace>/",
    exact: "<workspace>\\hello.txt",
    mixed: "<server>/logs and <server>",
    other: "C:\\Users\\PC\\data-other and C:\\Users\\PC\\database",
    drive: "D:\\Users\\PC\\data\\x"
  });
});

test("a Mac or Linux host's folders are matched exactly as before", () => {
  const scrub = pathScrubber([["/srv/out", "<output>"], ["/Users/me/site", "<workspace>"]]);
  assert.deepEqual(scrub(["/srv/out/a and /srv/outbox", "/users/me/site", "/Users/me/site/x"]), ["<output>/a and /srv/outbox", "/users/me/site", "<workspace>/x"]);
});

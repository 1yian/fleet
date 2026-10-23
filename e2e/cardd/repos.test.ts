import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";

let cardd: Cardd | undefined;
afterEach(async () => {
  await cardd?.stop();
  cardd = undefined;
});

test("project repo sets and corrects a project's GitHub repo, and refuses a malformed one", async () => {
  const c = await Cardd.start();
  cardd = c;
  c.addProject("web", { p620: "/clones/web" });

  assert.equal(c.setRepo("web", "acme/old-web"), "web: repo acme/old-web");
  assert.equal(c.setRepo("web", "acme/web"), "web: repo acme/web");

  assert.throws(() => c.setRepo("web", "acme"), {
    stderr: /project repo acme must be <owner>\/<name>/,
  });
  assert.throws(() => c.setRepo("nope", "acme/nope"), {
    stderr: /project nope is not in the registry/,
  });
});

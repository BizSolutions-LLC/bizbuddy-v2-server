"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { inspectFacePhoto } = require("../src/utils/facePhoto");

describe("inspectFacePhoto", () => {
  it("rejects an empty file", () => {
    const result = inspectFacePhoto({ buffer: Buffer.alloc(0) });
    assert.equal(result.ok, false);
  });

  it("accepts a JPEG header", () => {
    const result = inspectFacePhoto({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    assert.equal(result.ok, true);
    assert.equal(result.mime, "image/jpeg");
  });

  it("accepts a PNG header", () => {
    const result = inspectFacePhoto({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.mime, "image/png");
  });

  it("rejects text renamed as a photo", () => {
    const result = inspectFacePhoto({ buffer: Buffer.from("not-an-image") });
    assert.equal(result.ok, false);
  });
});

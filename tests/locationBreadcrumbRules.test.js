"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkBatchShape, classifySample, cleanSource } = require("../src/services/Locations/locationBreadcrumbRules");

const now = new Date("2026-11-20T12:00:00.000Z");
const openLog = { id: "log-1", timeIn: "2026-11-20T08:00:00.000Z", timeOut: null };

function sample(overrides) {
  return {
    timeLogId: "log-1",
    recordedAt: "2026-11-20T11:00:00.000Z",
    latitude: 14.55,
    longitude: 121.02,
    ...overrides,
  };
}

describe("locationBreadcrumbRules", () => {
  it("rejects an empty batch and a batch over 50", () => {
    assert.equal(checkBatchShape({ samples: [] }).error.code, "INVALID_SAMPLES");
    assert.equal(checkBatchShape({ samples: new Array(51).fill({}) }).error.code, "TOO_MANY_SAMPLES");
    assert.equal(checkBatchShape({ samples: [sample()] }).samples.length, 1);
  });

  it("rejects a bad point, a future time, a time before clock-in, and a foreign id shape", () => {
    assert.equal(classifySample(sample({ latitude: 0, longitude: 0 }), openLog, now).status, "rejected");
    assert.equal(classifySample(sample({ recordedAt: "2026-11-20T12:03:00.000Z" }), openLog, now).reason, "recordedAt is in the future.");
    assert.equal(classifySample(sample({ recordedAt: "2026-11-20T07:00:00.000Z" }), openLog, now).reason, "recordedAt is before clock-in.");
    assert.equal(classifySample(sample({ timeLogId: 12 }), openLog, now).reason, "Punch not found.");
  });

  it("accepts a sample during an open punch and stores a mocked flag decision separately", () => {
    const result = classifySample(sample(), openLog, now);
    assert.equal(result.status, "ok");
    assert.equal(result.recordedAt.toISOString(), "2026-11-20T11:00:00.000Z");
    assert.equal(cleanSource("background"), "background");
    assert.equal(cleanSource("spoofed"), null);
  });

  it("rejects a sample after clock-out", () => {
    const closed = { ...openLog, timeOut: "2026-11-20T10:00:00.000Z" };
    assert.equal(classifySample(sample(), closed, now).reason, "recordedAt is after clock-out.");
  });
});

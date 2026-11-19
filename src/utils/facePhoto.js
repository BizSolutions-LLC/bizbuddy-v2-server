"use strict";

function inspectFacePhoto(file) {
  if (!file?.buffer?.length) {
    return { ok: false, message: "A face photo is required." };
  }
  const jpeg = file.buffer[0] === 0xff && file.buffer[1] === 0xd8;
  const png =
    file.buffer[0] === 0x89 &&
    file.buffer[1] === 0x50 &&
    file.buffer[2] === 0x4e &&
    file.buffer[3] === 0x47;
  if (!jpeg && !png) {
    return { ok: false, message: "The face photo must be a JPEG or PNG." };
  }
  return {
    ok: true,
    mime: jpeg ? "image/jpeg" : "image/png",
    name: jpeg ? "face.jpg" : "face.png",
  };
}

module.exports = { inspectFacePhoto };

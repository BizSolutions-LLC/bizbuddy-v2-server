// src/utils/describeDevice.js
//
// BB-144: a short, human description of the device behind a request, for the
// password emails ("Chrome on Windows", "BizBuddy app on iPhone"). Read from
// the user agent only: no IP lookup, no outside service. Best effort: unknown
// agents give null and the email simply leaves the row out.

const { punchSource } = require("@utils/punchDeviceProof");

function osOf(ua) {
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/mac os x|macintosh/i.test(ua)) return "Mac";
  if (/darwin|cfnetwork/i.test(ua)) return "iPhone"; // iOS networking stack
  if (/okhttp/i.test(ua)) return "Android";
  if (/linux/i.test(ua)) return "Linux";
  return null;
}

function browserOf(ua) {
  if (/edg(e|a|ios)?\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return null;
}

/** @param {object|string|null} reqOrUa  Express request or a user-agent string */
function describeDevice(reqOrUa) {
  const ua = typeof reqOrUa === "string" ? reqOrUa : reqOrUa?.get?.("user-agent") || reqOrUa?.headers?.["user-agent"] || "";
  if (!ua) return null;
  const os = osOf(ua);
  if (punchSource(ua) === "app") return os ? `BizBuddy app on ${os}` : "BizBuddy app";
  const browser = browserOf(ua);
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || null;
}

module.exports = { describeDevice };

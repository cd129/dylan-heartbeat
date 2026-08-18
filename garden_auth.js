const crypto = require("crypto");

function safeSecretEqual(expected, supplied) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(supplied || ""), "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { safeSecretEqual };

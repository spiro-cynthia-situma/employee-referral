"use strict";

module.exports = function startKeepAlive() {
  if (process.env.NODE_ENV !== "production" || !process.env.RENDER_EXTERNAL_URL)
    return;

  const https = require("https");
  const url = `${process.env.RENDER_EXTERNAL_URL}/api/health`;

  setInterval(
    () => {
      https
        .get(url, (res) => {
          console.log(`🏓  Keep-alive ping → ${res.statusCode}`);
        })
        .on("error", (e) => {
          console.error("Keep-alive ping failed:", e.message);
        });
    },
    10 * 60 * 1000,
  ); // every 10 minutes
};

'use strict';
// One home for cross-cutting constants so the server and the launch-at-login installer never
// disagree. DEFAULT_PORT is 7071 — 7070 is commonly taken by other local dev servers (it was on
// the build machine). Override at runtime with HARBOR_PORT.
module.exports = {
  DEFAULT_PORT: 7071,
};

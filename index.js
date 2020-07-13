/* jshint esversion: 9 */
"use strict";
module.exports = function (homebridge) {
   let eWeLink = require("./lib/eWeLink.js")(homebridge);
   homebridge.registerPlatform("homebridge-ewelink-sonoff", "eWeLink", eWeLink, true);
};
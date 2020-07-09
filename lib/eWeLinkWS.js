/* jshint esversion: 9 */
"use strict";
const axios = require('axios');
const constants = require('./constants');
const nonce = require("nonce")();
module.exports = class eWeLinkWS {
   constructor(log, apiHost, aToken, debug) {
      this.log = log;
      this.apiHost = apiHost;
      this.aToken = aToken;
      this.debug = debug;
   }
   getHost() {
      return new Promise((resolve, reject) => {
         axios({
            method: "post",
            url: "https://" + this.apiHost.replace("-api", "-disp") + "/dispatch/app",
            headers: {
               Authorization: "Bearer " + this.aToken,
               "Content-Type": "application/json;charset=UTF-8"
            },
            data: {
               accept: "mqtt,ws",
               appid: constants.appId,
               nonce: nonce(),
               ts: Math.floor(new Date().getTime() / 1000),
               version: 8
            }
         }).then((res) => {
            let body = res.data;
            if (!body.domain) {
               throw "Server did not respond with a web socket host.";
            }
            if (this.debug) {
               this.log("Web socket host received [%s].", body.domain);
            }
            resolve(body.domain);
         }).catch((err) => {
            this.log.error("** Could not load homebridge-ewelink-sonoff **");
            this.log.warn("No web socket host - %s.", err);
            reject("An error occurred whilst getting web socket host. Please see Homebridge log");
         });
      });
   }
};
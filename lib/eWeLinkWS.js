/* jshint esversion: 9 */
"use strict";
const axios = require('axios');
const constants = require('./constants');
const eventemitter = require('events');
const nonce = require("nonce")();
const ws = require("ws");
let platform;
module.exports = class eWeLinkWS {
   constructor(log, apiHost, aToken, apiKey, debug, redactLogs) {
      platform = this;
      platform.log = log;
      platform.apiHost = apiHost;
      platform.aToken = aToken;
      platform.apiKey = apiKey;
      platform.debug = debug;
      platform.redactLogs = redactLogs;
      platform.wsIsOpen = false;
      platform.emitter = new eventemitter();
      platform.delaySend = 0;
   }
   getHost() {
      return new Promise((resolve, reject) => {
         axios({
            method: "post",
            url: "https://" + platform.apiHost.replace("-api", "-disp") + "/dispatch/app",
            headers: {
               Authorization: "Bearer " + platform.aToken,
               "Content-Type": "application/json;charset=UTF-8"
            },
            data: {
               accept: "mqtt,ws",
               appid: constants.appId,
               nonce: nonce(),
               ts: Math.floor(new Date().getTime() / 1000),
               version: 8
            }
         }).then(res => {
            let body = res.data;
            if (!body.domain) {
               throw "Server did not respond with a web socket host.";
            }
            if (platform.debug) {
               platform.log("Web socket host received [%s].", body.domain);
            }
            platform.wsHost = body.domain;
            resolve(body.domain);
         }).catch(err => {
            reject(err);
         });
      });
   }
   login() {
      platform.ws = new ws("wss://" + platform.wsHost + ":8080/api/ws");
      platform.ws.on("open", () => {
         platform.wsIsOpen = true;
         let payload = {
            action: "userOnline",
            at: platform.aToken,
            apikey: platform.apiKey,
            appid: constants.appId,
            nonce: nonce(),
            ts: Math.floor(new Date() / 1000),
            userAgent: "app",
            sequence: Math.floor(new Date()),
            version: 8
         };
         platform.ws.send(JSON.stringify(payload));
         if (platform.debug) {
            let rct = JSON.stringify(payload, null, 2);
            if (platform.redactLogs) {
               rct = rct.replace(platform.aToken, "**hidden**").replace(platform.apiKey, "**hidden**");
            }
            platform.log.warn("Sending web socket login request. This text is yellow so it's clearer to distinguish. It is not an error.\n%s", rct);
         }
      });
      platform.ws.on("message", m => {
         if (m === "pong") {
            return;
         }
         let device;
         try {
            device = JSON.parse(m);
         } catch (e) {
            platform.log.warn("An error occured reading the web socket message [%s]", e);
            return;
         }
         if (platform.debug) {
            let rct = JSON.stringify(device, null, 2);
            if (platform.redactLogs) {
               rct = rct.replace(device.deviceid, "**hidden**").replace(device.apikey, "**hidden**");
            }
            platform.log.warn("Web socket message received. This text is yellow so it's clearer to distinguish. It is not an error.\n%s", rct);
         }
         if (device.hasOwnProperty("config") && device.config.hb && device.config.hbInterval && !platform.hbInterval) {
            platform.hbInterval = setInterval(function () {
               platform.ws.send("ping");
            }, (device.config.hbInterval + 7) * 1000);
         } else if (device.hasOwnProperty("action")) {
            platform.emitter.emit('update', device);
         } else if (platform.debug) {
            platform.log.warn("Unknown command received via web socket.");
         }
      });
      platform.ws.on("close", (e) => {
         platform.log.warn("Web socket closed - [%s].", e);
         if (e.code !== 1000) {
            platform.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            platform.ws.removeAllListeners();
            setTimeout(function () {
               platform.ws.open();
            }, 5000);
         } else {
            platform.log.warn("If this was unexpected then please try restarting Homebridge.");
         }
         platform.log.error("Please try restarting Homebridge so that this plugin can work again.");
         platform.wsIsOpen = false;
         if (platform.hbInterval) {
            clearInterval(platform.hbInterval);
            platform.hbInterval = null;
         }
      });
      platform.ws.on("error", (e) => {
         platform.log.error("Web socket error - [%s].", e);
         if (e.code === "ECONNREFUSED") {
            platform.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            platform.ws.removeAllListeners();
            setTimeout(function () {
               platform.ws.open();
            }, 5000);
         } else {
            platform.log.warn("If this was unexpected then please try restarting Homebridge.");
         }
      });
   }
   sendUpdate(json, callback) {
      json = {
         ...json,
         ...{
            action: "update",
            sequence: Math.floor(new Date()),
            userAgent: "app"
         }
      };
      let sendOperation = m => {
         if (!platform.wsIsOpen) {
            setTimeout(() => {
               sendOperation(m);
            }, 280);
            return;
         }
         if (platform.ws) {
            platform.ws.send(m);
            if (platform.debug) {
               let rct = JSON.stringify(json, null, 2);
               if (platform.redactLogs) {
                  rct = rct.replace(json.apikey, "**hidden**").replace(json.deviceid, "**hidden**");
               }
               platform.log.warn("Web socket message sent. This text is yellow so it's clearer to distinguish. It is not an error.\n%s", rct);
            }
            callback();
         }
         platform.delaySend = platform.delaySend <= 0 ? 0 : platform.delaySend -= 280;
      };
      let string = JSON.stringify(json);
      if (platform.wsIsOpen) {
         setTimeout(sendOperation, platform.delaySend, string);
         platform.delaySend += 280;
      } else {
         platform.log.warn("Web socket is currently reconnecting. Command will be resent.");
         let interval;
         let waitToSend = m => {
            if (platform.wsIsOpen) {
               clearInterval(interval);
               sendOperation(m);
            }
         };
         interval = setInterval(waitToSend, 2500, string);
      }
   }
   receiveUpdate(f) {
      this.emitter.addListener('update', f);
   }
};
/* jshint esversion: 9, -W030, node: true */
"use strict";
const axios = require("axios");
const constants = require("./constants");
const eventemitter = require("events");
const nonce = require("nonce")();
const ws = require("ws");
module.exports = class eWeLinkWS {
   constructor(config, log, res) {
      this.config = config;
      this.log = log;
      this.debug = this.config.debug || false;
      this.httpHost = res.httpHost;
      this.aToken = res.aToken;
      this.apiKey = res.apiKey;
      this.wsIsOpen = false;
      this.emitter = new eventemitter();
      this.delaySend = 0;
   }
   getHost() {
      return new Promise((resolve, reject) => {
         axios({
            method: "post",
            url: "https://" + this.httpHost.replace("-api", "-disp") + "/dispatch/app",
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
         }).then(res => {
            let body = res.data;
            if (!body.domain) {
               throw "Server did not respond with a web socket host.";
            }
            if (this.debug) {
               this.log("Web socket host received [%s].", body.domain);
            }
            this.wsHost = body.domain;
            resolve(body.domain);
         }).catch(err => {
            reject(err);
         });
      });
   }
   login() {
      this.ws = new ws("wss://" + this.wsHost + ":8080/api/ws");
      this.ws.on("open", () => {
         this.wsIsOpen = true;
         let payload = {
            action: "userOnline",
            at: this.aToken,
            apikey: this.apiKey,
            appid: constants.appId,
            nonce: nonce(),
            ts: Math.floor(new Date() / 1000),
            userAgent: "app",
            sequence: Math.floor(new Date()),
            version: 8
         };
         this.ws.send(JSON.stringify(payload));
         if (this.debug) {
            let msg = JSON.stringify(payload, null, 2).replace(this.aToken, "**hidden**").replace(this.apiKey, "**hidden**");
            this.log.warn("Sending WS login request. This text is yellow for clarity.\n%s", msg);
         }
      });
      this.ws.on("message", m => {
         if (m === "pong") {
            return;
         }
         let device;
         try {
            device = JSON.parse(m);
         } catch (e) {
            this.log.warn("An error occured reading the web socket message [%s]", e);
            return;
         }
         if (device.hasOwnProperty("deviceid") && device.hasOwnProperty("params") && device.hasOwnProperty("error") && device.error === 0) {
            device.action = "update";
         } else if (device.hasOwnProperty("deviceid") && device.hasOwnProperty("error") && device.error === 504) {
            device.action = "sysmsg";
            device.params = {
               online: false
            };
         }
         if (device.hasOwnProperty("config") && device.config.hb && device.config.hbInterval && !this.hbInterval) {
            this.hbInterval = setInterval(() => {
               this.ws.send("ping");
            }, (device.config.hbInterval + 7) * 1000);
         } else if (device.hasOwnProperty("action")) {
            switch (device.action) {
               case "sysmsg":
               let returnTemplate = {
                  source: "ws",
                  deviceid: device.deviceid,
                  action: "sysmsg",
                  params: device.params
               };
               if (this.debug) {
                  let msg = JSON.stringify(returnTemplate, null, 2).replace(device.deviceid, "**hidden**");
                  this.log("WS message received.\n%s", msg);
               }
               this.emitter.emit("update", returnTemplate);
               break;
               case "update":
               let params = device.params;
               constants.paramsToRemove.forEach(prop => {
                  if (params.hasOwnProperty(prop)) {
                     delete params[prop];
                  }
               });
               if (Object.keys(params).length > 0) {
                  let returnTemplate = {
                     source: "ws",
                     deviceid: device.deviceid,
                     action: "update",
                     params
                  };
                  if (this.debug) {
                     let msg = JSON.stringify(returnTemplate, null, 2).replace(device.deviceid, "**hidden**");
                     this.log("WS message received.\n%s", msg);
                  }
                  this.emitter.emit("update", returnTemplate);
               } else {
                  if (this.debug) {
                     this.log("[%s] WS message has nothing useful for Homebridge.", device.deviceid);
                  }
               }
               break;
               default:
               this.log.warn("[%s] WS message has unknown action.", device.deviceid);
               return;
            }
         } else if (device.hasOwnProperty("error") && device.error === 0) {
         } else {
            if (this.debug) {
               this.log.warn("WS unknown command received.");
            }
         }
      });
      this.ws.on("close", (e) => {
         this.log.warn("Web socket closed - [%s].", e);
         if (e.code !== 1000) {
            this.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            this.ws.removeAllListeners();
            setTimeout(() => {
               this.login();
            }, 5000);
         } else {
            this.log.error("Please try restarting Homebridge so that this plugin can work again.");
         }
         this.wsIsOpen = false;
         if (this.hbInterval) {
            clearInterval(this.hbInterval);
            this.hbInterval = null;
         }
      });
      this.ws.on("error", (e) => {
         this.log.error("Web socket error - [%s].", e);
         if (e.code === "ECONNREFUSED") {
            this.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            this.ws.removeAllListeners();
            setTimeout(() => {
               this.login();
            }, 5000);
         } else {
            this.log.warn("If this was unexpected then please try restarting Homebridge.");
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
         if (!this.wsIsOpen) {
            setTimeout(() => {
               sendOperation(m);
            }, 280);
            return;
         }
         if (this.ws) {
            this.ws.send(m);
            if (this.debug) {
               let msg = JSON.stringify(json, null, 2).replace(json.apikey, "**hidden**").replace(json.deviceid, "**hidden**");
               this.log.warn("Web socket message sent. This text is yellow for clarity.\n%s", msg);
            }
            callback();
         }
         this.delaySend = this.delaySend <= 0 ? 0 : this.delaySend -= 280;
      };
      let string = JSON.stringify(json);
      if (this.wsIsOpen) {
         setTimeout(sendOperation, this.delaySend, string);
         this.delaySend += 280;
      } else {
         this.log.warn("Web socket is currently reconnecting. Command will be resent.");
         let interval;
         let waitToSend = m => {
            if (this.wsIsOpen) {
               clearInterval(interval);
               sendOperation(m);
            }
         };
         interval = setInterval(waitToSend, 2500, string);
      }
   }
   requestUpdate(deviceid) {
      let json = {
         action: "query",
         apikey: this.apiKey,
         deviceid,
         params: [],
         sequence: Math.floor(new Date()),
         ts: 0,
         userAgent: "app"
      };
      let sendOperation = m => {
         if (!this.wsIsOpen) {
            setTimeout(() => {
               sendOperation(m);
            }, 280);
            return;
         }
         if (this.ws) {
            this.ws.send(m);
            if (this.debug) {
               let msg = JSON.stringify(json, null, 2).replace(json.apikey, "**hidden**").replace(json.deviceid, "**hidden**");
               this.log.warn("Web socket message sent. This text is yellow for clarity.\n%s", msg);
            }
            return;
         }
         this.delaySend = this.delaySend <= 0 ? 0 : this.delaySend -= 280;
      };
      let string = JSON.stringify(json);
      if (this.wsIsOpen) {
         setTimeout(sendOperation, this.delaySend, string);
         this.delaySend += 280;
      } else {
         this.log.warn("Web socket is currently reconnecting. Command will be resent.");
         let interval;
         let waitToSend = m => {
            if (this.wsIsOpen) {
               clearInterval(interval);
               sendOperation(m);
            }
         };
         interval = setInterval(waitToSend, 2500, string);
      }
   }
   receiveUpdate(f) {
      this.emitter.addListener("update", f);
   }
};
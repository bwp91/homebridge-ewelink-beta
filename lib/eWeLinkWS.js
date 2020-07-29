/* jshint esversion: 9, -W030, node: true */
"use strict";
const axios = require("axios");
const constants = require("./constants");
const eventemitter = require("events");
const nonce = require("nonce")();
const ws = require("ws");
const wsp = require('websocket-as-promised');
module.exports = class eWeLinkWS {
   constructor(config, log, res) {
      this.config = config;
      this.log = log;
      this.debug = this.config.debug || false;
      this.debugReqRes = this.config.debugReqRes || false;
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
      this.wsp = new wsp("wss://" + this.wsHost + ":8080/api/ws", {
         createWebSocket: url => new ws(url),
         extractMessageData: event => event,
         attachRequestId: (data, requestId) => Object.assign({
            sequence: requestId
         }, data),
         extractRequestId: data => data && data.sequence,
         packMessage: data => JSON.stringify(data),
         unpackMessage: data => {
            return data === "pong" ?
               data :
               JSON.parse(data);
         }
      });
      this.wsp.open();
      this.wsp.onOpen.addListener(() => {
         this.wsIsOpen = true;
         let sequence = Math.floor(new Date()).toString();
         let payload = {
            action: "userOnline",
            at: this.aToken,
            apikey: this.apiKey,
            appid: constants.appId,
            nonce: nonce(),
            ts: Math.floor(new Date() / 1000),
            userAgent: "app",
            sequence,
            version: 8
         };
         if (this.debugReqRes) {
            let msg = JSON.stringify(payload, null, 2).replace(this.aToken, "**hidden**").replace(this.apiKey, "**hidden**");
            this.log.warn("Sending WS login request. This text is yellow for clarity.\n%s", msg);
         } else if (this.debug) {
            this.log("Sending WS login request.");
         }
         this.wsp.sendRequest(payload, {
            requestId: sequence
         }).then(res => {
            if (res.hasOwnProperty("config") && res.config.hb && res.config.hbInterval && !this.hbInterval) {
               this.hbInterval = setInterval(() => {
                  this.wsp.send("ping");
               }, (res.config.hbInterval + 7) * 1000);
            } else {
               throw "Unknown parameters received";
            }
         }).catch(err => {
            this.log.error("WS login failed [%s].", err);
         });
      });
      this.wsp.onUnpackedMessage.addListener(device => {
         if (device === "pong") {
            return;
         }
         if (device.hasOwnProperty("deviceid") && device.hasOwnProperty("error")) {
            switch (device.error) {
            case 0:
               if (device.hasOwnProperty("params")) {
                  device.action = "update";
               }
               break;
            case 504:
               device.action = "sysmsg";
               device.params = {
                  online: false
               };
               break;
            }
         }
         if (device.hasOwnProperty("action")) {
            switch (device.action) {
            case "sysmsg":
               let returnTemplate = {
                  source: "ws",
                  deviceid: device.deviceid,
                  action: "sysmsg",
                  params: device.params
               };
               if (this.debugReqRes) {
                  let msg = JSON.stringify(returnTemplate, null, 2).replace(device.deviceid, "**hidden**");
                  this.log("WS message received.\n%s", msg);
               } else if (this.debug) {
                  this.log("WS message received.");
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
                  if (this.debugReqRes) {
                     let msg = JSON.stringify(returnTemplate, null, 2).replace(device.deviceid, "**hidden**");
                     this.log("WS message received.\n%s", msg);
                  } else if (this.debug) {
                     this.log("WS message received.");
                  }
                  this.emitter.emit("update", returnTemplate);
               }
               break;
            default:
               return;
            }
         }
      });
      this.wsp.onClose.addListener(e => {
         this.log.warn("Web socket closed - [%s].", e);
         if (e.code !== 1000) {
            this.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            this.wsp.removeAllListeners();
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
      this.wsp.onError.addListener(e => {
         this.log.error("Web socket error - [%s].", e);
         if (e.code === "ECONNREFUSED") {
            this.log.warn("Web socket will try to reconnect in five seconds then try the command again.");
            this.wsp.removeAllListeners();
            setTimeout(() => {
               this.login();
            }, 5000);
         } else {
            this.log.warn("If this was unexpected then please try restarting Homebridge.");
         }
      });
   }
   sendUpdate(json, callback) {
      let sequence = Math.floor(new Date()).toString();
      json = {
         ...json,
         ...{
            action: "update",
            sequence,
            userAgent: "app"
         }
      };
      let sendOperation = req => {
         if (!this.wsIsOpen) {
            setTimeout(() => {
               sendOperation(req);
            }, 280);
            return;
         }
         if (this.wsp) {
            if (this.debugReqRes) {
               let msg = JSON.stringify(json, null, 2).replace(json.apikey, "**hidden**").replace(json.deviceid, "**hidden**");
               this.log.warn("Web socket message sent. This text is yellow for clarity.\n%s", msg);
            } else if (this.debug) {
               this.log("Web socket message sent.");
            }
            this.wsp.sendRequest(req, {
               requestId: sequence
            }).then(device => {
               device.error = device.hasOwnProperty("error") ?
                  device.error :
                  504; // mimic ewelink device offline
               switch (device.error) {
               case 0:
                  callback();
                  break;
               case 504:
               default:
                  throw "Unknown response";
               }
            }).catch(err => {
               let str = "Device update failed [" + err + "].";
               this.log.error(str);
               callback(str);
            });
         }
         this.delaySend = this.delaySend <= 0 ? 0 : this.delaySend -= 280;
      };
      if (this.wsIsOpen) {
         setTimeout(sendOperation, this.delaySend, json);
         this.delaySend += 280;
      } else {
         this.log.warn("Web socket is currently reconnecting. Command will be resent.");
         let interval;
         let waitToSend = req => {
            if (this.wsIsOpen) {
               clearInterval(interval);
               sendOperation(req);
            }
         };
         interval = setInterval(waitToSend, 2500, json);
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
         if (this.wsp) {
            this.wsp.send(m);
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
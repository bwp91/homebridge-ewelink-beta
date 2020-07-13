/* jshint esversion: 9 */
"use strict";
const axios = require('axios');
const constants = require('./constants');
const crypto = require("crypto");
const nonce = require("nonce")();
module.exports = class eWeLinkHTTP {
   constructor(config, log, debug, redactLogs) {
      this.config = config;
      this.log = log;
      this.debug = debug;
      this.redactLogs = redactLogs;
   }
   login() {
      let data = {
         appid: constants.appId,
         nonce: nonce(),
         password: this.config.password,
         ts: Math.floor(new Date().getTime() / 1000),
         version: 8
      };
      if (this.config.username.includes("@")) {
         data.email = this.config.username;
      } else {
         data.phoneNumber = this.config.username;
      }
      if (this.debug) {
         let rct = JSON.stringify(data, null, 2);
         if (this.redactLogs) {
            rct = rct.replace(this.config.username, "**hidden**").replace(this.config.password, "**hidden**");
         }
         this.log.warn("Sending HTTP login request. This text is yellow so it's clearer to distinguish. It is not an error.\n%s", rct);
      }
      let dataToSign = crypto.createHmac("sha256", "6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM").update(JSON.stringify(data)).digest("base64");
      return new Promise((resolve, reject) => {
         axios({
            url: "https://" + this.httpHost + "/api/user/login",
            method: "post",
            headers: {
               Authorization: "Sign " + dataToSign,
               "Content-Type": "application/json;charset=UTF-8"
            },
            data: data
         }).then(res => {
            let body = res.data;
            if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
               switch (body.region) {
               case "eu":
               case "us":
               case "as":
                  this.httpHost = body.region + "-api.coolkit.cc:8080";
                  break;
               case "cn":
                  this.httpHost = "cn-api.coolkit.cn:8080";
                  break;
               default:
                  throw "No valid region received - [" + body.region + "].";
               }
               if (this.debug) {
                  this.log("New HTTP API host received [%s].", this.httpHost);
               }
               this.login();
               return;
            }
            if (!body.at) {
               throw "Server did not respond with an authentication token. Please double check your eWeLink username and password in the Homebridge configuration.\n" + JSON.stringify(body, null, 2);
            }
            if (this.debug) {
               this.log("Authorisation token received [%s].", body.at);
               this.log("User API key received [%s].", body.user.apikey);
            }
            this.aToken = body.at;
            this.apiKey = body.user.apikey;
            resolve({
               aToken: body.at,
               apiKey: body.user.apikey
            });
         }).catch(err => {
            reject(err);
         });
      });
   }
   getHost() {
      let data = {
         country_code: this.config.countryCode,
         version: 8,
         ts: Math.floor(new Date().getTime() / 1000),
         nonce: nonce(),
         appid: constants.appId
      };
      let dataToSign = [];
      Object.keys(data).forEach(function (key) {
         dataToSign.push({
            key: key,
            value: data[key]
         });
      });
      dataToSign.sort(function (a, b) {
         return a.key < b.key ? -1 : 1;
      });
      dataToSign = dataToSign.map(function (kv) {
         return kv.key + "=" + kv.value;
      }).join("&");
      dataToSign = crypto.createHmac("sha256", "6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM").update(dataToSign).digest("base64");
      return new Promise((resolve, reject) => {
         axios.get("https://api.coolkit.cc:8080/api/user/region", {
            headers: {
               Authorization: "Sign " + dataToSign,
               "Content-Type": "application/json;charset=UTF-8"
            },
            params: data
         }).then(res => {
            let body = res.data;
            if (!body.region) {
               throw "Server did not respond with a region.\n" + JSON.stringify(body, null, 2);
            }
            switch (body.region) {
            case "eu":
            case "us":
            case "as":
               this.httpHost = body.region + "-api.coolkit.cc:8080";
               break;
            case "cn":
               this.httpHost = "cn-api.coolkit.cn:8080";
               break;
            default:
               throw "No valid region received - [" + body.region + "].";
            }
            if (this.debug) {
               this.log("HTTP API host received [%s].", this.httpHost);
            }
            resolve(this.httpHost);
         }).catch(err => {
            reject(err);
         });
      });
   }
   getDevices() {
      return new Promise((resolve, reject) => {
         axios.get("https://" + this.httpHost + "/api/user/device", {
            params: {
               apiKey: this.apiKey,
               version: 8,
               ts: Math.floor(new Date().getTime() / 1000),
               nonce: nonce(),
               appid: constants.appId
            },
            headers: {
               Authorization: "Bearer " + this.aToken
            }
         }).then(res => {
            let body = res.data;
            if (!body.hasOwnProperty("error") || (body.hasOwnProperty("error") && body.error !== 0)) {
               throw JSON.stringify(body, null, 2);
            }
            resolve(body.devicelist);
         }).catch((err) => {
            reject(err);
         });
      });
   }
};
/* jshint esversion: 9, -W030, node: true */
"use strict";
const crypto = require('crypto');
const dns = require('node-dns-sd');
const eventemitter = require('events');
module.exports = class eWeLinkLAN {
   constructor(config, log, devices) {
      this.config = config;
      this.log = log;
      this.devices = devices;
      let deviceMap = {};
      devices.forEach(device => {
         deviceMap[device.deviceid] = {
            apiKey: device.devicekey,
            ip: false
         };
      });
      this.deviceMap = deviceMap;
      this.debug = this.config.debug || false;
      this.redactLogs = this.config.redactLogs || true;
      this.wsIsOpen = false;
      this.emitter = new eventemitter();
      this.delaySend = 0;
   }
   getHosts() {
      return new Promise((resolve, reject) => {
         dns.discover({
            name: "_ewelink._tcp.local"
         }).then(res => {
            res.forEach(device => {
               let a = device.fqdn.replace("._ewelink._tcp.local", "").replace("eWeLink_", "");
               if (this.deviceMap.hasOwnProperty(a)) {
                  this.deviceMap[a].ip = device.address;
               }
            });
            resolve(this.deviceMap);
         }).catch(err => {
            reject(err);
         });
      });
   }
   startMonitor() {
      dns.ondata = (packet) => {
         if (packet.answers) {
            packet.answers
               .filter(value => value.name.includes("_ewelink._tcp.local"))
               .forEach(value => {
                  if (value.type === "TXT") {
                     let rdata = value.rdata;
                     if (this.deviceMap.hasOwnProperty(rdata.id)) {
                        let deviceKey = this.deviceMap[rdata.id].apiKey;
                        let data = rdata.data1 +
                           (rdata.hasOwnProperty("data2") ? rdata.data2 : "") +
                           (rdata.hasOwnProperty("data3") ? rdata.data3 : "") +
                           (rdata.hasOwnProperty("data4") ? rdata.data4 : "");
                        let key = crypto.createHash("md5").update(Buffer.from(deviceKey, "utf8")).digest();
                        let dText = crypto.createDecipheriv("aes-128-cbc", key, Buffer.from(rdata.iv, "base64"));
                        let pText = Buffer.concat([dText.update(Buffer.from(data, "base64")), dText.final()]).toString("utf8");
                        let returnTemplate = {
                           action: "update",
                           deviceid: rdata.id,
                           params: JSON.parse(pText)
                        };
                        if (this.debug) {
                           this.log("[%s] LAN mode message received. Refreshing device.", rdata.id);
                        }
                        this.emitter.emit('update', returnTemplate);
                     }
                  }
               });
         }
      };
      return new Promise((resolve, reject) => {
         dns.startMonitoring().then(() => {
            resolve();
         }).catch(err => {
            reject(err);
         });
      });
   }
   sendUpdate(json, callback) {
      return;
   }
   receiveUpdate(f) {
      this.emitter.addListener('update', f);
   }
};
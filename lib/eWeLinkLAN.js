/* jshint esversion: 9 */
"use strict";
const dns = require('node-dns-sd');
const eventemitter = require('events');
let platform;
module.exports = class eWeLinkLAN {
   constructor(log, debug, redactLogs) {
      platform = this;
      platform.log = log;
      platform.debug = debug;
      platform.redactLogs = redactLogs;
      platform.wsIsOpen = false;
      platform.emitter = new eventemitter();
      platform.delaySend = 0;
   }
   getHosts() {
      return new Promise((resolve, reject) => {
         dns.discover({
            name: "_ewelink._tcp.local"
         }).then((res) => {
            let devices = {};
            res.forEach(device => {
               let a = device.fqdn.replace("._ewelink._tcp.local", "").replace("eWeLink_", "");
               devices[a] = device.address;
            });
            resolve(devices);
         }).catch(err => {
            reject(err);
         });
      });
   }
   startMonitor() {
      dns.ondata = (packet) => {
         if (packet.answers[0] !== undefined) {
            if (packet.answers[0].name === "_ewelink._tcp.local") {
               platform.emitter.emit('update', packet);
            }
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
   receiveUpdate(f) {
      platform.emitter.addListener('update', f);
   }
};
/* jshint esversion: 9 */
"use strict";
const dns = require('node-dns-sd');
const eventemitter = require('events');
module.exports = class eWeLinkLAN {
   constructor(config, log) {
      this.config = config;
      this.log = log;
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
         // if (res.answers) {
         // res.answers
         //     .filter(value => value.name === deviceName)
         //     .forEach(value => {
         //         if (this.logDnsResponses) {
         //          this.log.debug('DNS Response: %o', value);
         //       }
         // 
         //       if (value.type === 'TXT') {
         // 
         //           const txt = this.processDnsResponse(value);
         //        if (this.logDnsResponses) {
         //            this.log.debug('Processed TXT record for %s: %o', deviceId, txt);
         //        }
         //        status.params = txt.params;
         //let result = dnsRW.DNSPacket.parse(packet); need to get buffer
         //this.log.warn(result);
         if (packet.answers[0] !== undefined) {
            if (packet.answers[0].name === "_ewelink._tcp.local") {
               this.log(packet);
               this.emitter.emit('update', packet);
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
      this.emitter.addListener('update', f);
   }
};
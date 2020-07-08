const axios = require("axios");
const constants = require('./src/constants');
const convert = require("color-convert");
const crypto = require("crypto");
const nonce = require("nonce")();
const wsc = require("./src/wsc");
let Accessory;
let Characteristic;
let Service;
let UUIDGen;
let platform;
module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   homebridge.registerPlatform("homebridge-ewelink-sonoff", "eWeLink", eWeLink, true);
};
class eWeLink {
   constructor(log, config, api) {
      if (!log || !api) return;
      if (!config || (!config.username || !config.password || !config.countryCode)) {
         log.error("** Cannot load homebridge-ewelink-sonoff **");
         log.warn("Make sure your eWeLink credentials are in the Homebridge configuration.");
         return;
      }
      platform = this;
      platform.log = log;
      platform.config = config;
      platform.api = api;
      platform.wsIsOpen = false;
      platform.debug = platform.config.debug || false;
      platform.sensorTimeLength = platform.config.sensorTimeLength || 2;
      platform.sensorTimeDifference = platform.config.sensorTimeDifference || 120;
      platform.devicesInHB = new Map();
      platform.devicesInEwe = new Map();
      platform.customGroup = new Map();
      platform.api.on("didFinishLaunching", function () {
         let afterLogin = function () {
            if (!platform.hasOwnProperty("apiKey")) return;
            let eWeLinkDevices;
            if (platform.debug) platform.log("Requesting a list of devices through the eWeLink HTTP API.");
            axios.get("https://" + platform.apiHost + "/api/user/device", {
               params: {
                  apiKey: platform.apiKey,
                  version: 8,
                  ts: Math.floor(new Date().getTime() / 1000),
                  nonce: nonce(),
                  appid: constants.appId
               },
               headers: {
                  Authorization: "Bearer " + platform.aToken
               }
            }).then((res) => {
               let body = res.data;
               if (!body.hasOwnProperty("error") || (body.hasOwnProperty("error") && body.error !== 0)) throw JSON.stringify(body, null, 2);
               eWeLinkDevices = body.devicelist;
            }).catch(function (error) {
               platform.log.error("** Cannot load homebridge-ewelink-sonoff **");
               platform.log.warn(error);
               return;
            }).then(function () {
               if (eWeLinkDevices === undefined) return;
               if (Object.keys(eWeLinkDevices).length === 0) {
                  platform.log("[0] primary devices were loaded from your eWeLink account so any eWeLink devices in the Homebridge cache will be removed.");
                  platform.log("This plugin will no longer load as there is no reason to continue.");
                  try {
                     platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", Array.from(platform.devicesInHB.values()));
                     platform.devicesInHB.clear();
                  } catch (e) {
                     platform.log.warn("Devices could not be removed from the cache - [%s].", e);
                  }
                  return;
               }
               eWeLinkDevices.forEach((device) => {
                  if (device.type === "10") platform.devicesInEwe.set(device.deviceid, device);
               });
               if (platform.config.groups && Object.keys(platform.config.groups).length > 0) {
                  platform.config.groups.forEach((group) => {
                     if (typeof group.deviceId !== "undefined" && platform.devicesInEwe.has(group.deviceId)) {
                        platform.customGroup.set(group.deviceId + "SWX", group);
                     }
                  });
               }
               platform.log("[%s] eWeLink devices were loaded from the Homebridge cache.", platform.devicesInHB.size);
               platform.log("[%s] primary devices were loaded from your eWeLink account.", platform.devicesInEwe.size);
               platform.log("[%s] custom groups were loaded from the configuration.", platform.customGroup.size);
               if (platform.devicesInHB.size > 0) {
                  platform.devicesInHB.forEach((accessory) => {
                     if (!platform.devicesInEwe.has(accessory.context.eweDeviceId)) {
                        try {
                           platform.devicesInHB.delete(accessory.context.hbDeviceId);
                           platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
                           platform.log("[%s] was not present in the HTTP API response will be removed from Homebridge.", accessory.displayName);
                        } catch (e) {
                           platform.log.warn("[%s] was not present in the HTTP API response but has not been removed - [%s].", accessory.displayName, e);
                        }
                     }
                  });
               }
               if (platform.debug) platform.log("Checking if devices need to be added/refreshed in the Homebridge cache.");
               if (platform.devicesInEwe.size > 0) {
                  platform.devicesInEwe.forEach((device) => {
                     let i;
                     let accessory;
                     // Add non-existing devices
                     if (!platform.devicesInHB.has(device.deviceid + "SWX") && !platform.devicesInHB.has(device.deviceid + "SW0")) {
                        //*** CUSTOM GROUPS ***//
                        if (platform.customGroup.has(device.deviceid + "SWX")) {
                           if (platform.customGroup.get(device.deviceid) + "SWX".type === "blind" && Array.isArray(device.params.switches)) {
                              platform.addAccessory(device, device.deviceid + "SWX", "blind");
                           } else if (platform.customGroup.get(device.deviceid + "SWX").type === "garageDoor" && device.params.hasOwnProperty("switch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "garageDoor");
                           }
                        }
                        //*** FANS ***//                              
                        else if (constants.devicesFan.includes(device.uiid)) {
                           if (Array.isArray(device.params.switches)) {
                              platform.addAccessory(device, device.deviceid + "SWX", "fan");
                           }
                        }
                        //*** THERMOSTATS ***//                                                                            
                        else if (constants.devicesThermostat.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("mainSwitch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "thermostat");
                           }
                        }
                        //*** OUTLETS ***//         
                        else if (constants.devicesOutlet.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "outlet");
                           }
                        }
                        //*** LIGHTS [SINGLE SWITCH] ***//
                        else if (constants.devicesSingleSwitch.includes(device.uiid) && constants.devicesSingleSwitchLight.includes(device.productModel)) {
                           if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "light");
                           }
                        }
                        //*** LIGHTS [MULTI SWITCH] ***//
                        else if (constants.devicesMultiSwitch.includes(device.uiid) && constants.devicesMultiSwitchLight.includes(device.productModel)) {
                           if (Array.isArray(device.params.switches)) {
                              for (i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "light");
                              }
                           }
                        }
                        //*** SINGLE SWITCHES ***//
                        else if (constants.devicesSingleSwitch.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("switch")) {
                              platform.addAccessory(device, device.deviceid + "SWX", "switch");
                           }
                        }
                        //*** MULTI SWITCHES ***//
                        else if (constants.devicesMultiSwitch.includes(device.uiid)) {
                           if (Array.isArray(device.params.switches)) {
                              for (i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "switch");
                              }
                           }
                        }
                        //*** BRIDGES ***//        
                        else if (constants.devicesBridge.includes(device.uiid)) {
                           if (device.params.hasOwnProperty("rfList")) {
                              for (i = 0; i <= Object.keys(device.params.rfList).length; i++) {
                                 platform.addAccessory(device, device.deviceid + "SW" + i, "bridge");
                              }
                           }
                        }
                        //*** NOT SUPPORTED ***//
                        else {
                           platform.log.warn("[%s] cannot be added as it is not supported by this plugin.", device.name);
                        }
                     }
                     // Refresh existing devices and also those that have just been added.
                     if (platform.devicesInHB.has(device.deviceid + "SWX")) {
                        accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                        if (accessory.reachable !== device.online) {
                           try {
                              accessory.reachable = device.online;
                              platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
                              platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
                           } catch (e) {}
                        }
                     } else if (platform.devicesInHB.has(device.deviceid + "SW0")) {
                        accessory = platform.devicesInHB.get(device.deviceid + "SW0");
                        if (accessory.reachable !== device.online) {
                           accessory.reachable = device.online;
                           let otherAccessory;
                           for (i = 0; i <= accessory.context.channelCount; i++) {
                              try {
                                 otherAccessory = platform.devicesInHB.get(device.deviceid + "SW" + i);
                                 otherAccessory.reachable = device.online;
                                 platform.devicesInHB.set(otherAccessory.context.hbDeviceId, otherAccessory);
                                 platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [otherAccessory]);
                              } catch (e) {}
                           }
                        }
                     } else {
                        platform.log.warn("[%s] could not be refreshed as it wasn't found in Homebridge.", device.name);
                        return;
                     }
                     if (!accessory.reachable) {
                        platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                        return;
                     }
                     if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                     accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                     //*** CUSTOM GROUPS ***//  
                     if (platform.customGroup.has(device.deviceid + "SWX")) {
                        if (platform.customGroup.get(device.deviceid + "SWX").type === "blind" && Array.isArray(device.params.switches)) {
                           platform.externalBlindUpdate(device.deviceid + "SWX", device.params);
                           return;
                        } else if (platform.customGroup.get(device.deviceid + "SWX").type === "garageDoor" && (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("pulse"))) {
                           platform.externalGarageDoorUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** FANS ***//                                        
                     else if (constants.devicesFan.includes(accessory.context.eweUIID)) {
                        if (Array.isArray(device.params.switches)) {
                           platform.externalFanUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** THERMOSTATS ***//                                    
                     else if (constants.devicesThermostat.includes(accessory.context.eweUIID)) {
                        if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                           platform.externalThermostatUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** OUTLETS ***//       
                     else if (constants.devicesOutlet.includes(accessory.context.eweUIID)) {
                        if (device.params.hasOwnProperty("switch")) {
                           platform.externalOutletUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** LIGHTS [SINGLE SWITCH] ***//
                     else if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID) && constants.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                        if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                           platform.externalSingleLightUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** LIGHTS [MULTI SWITCH] ***//
                     else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID) && constants.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                        if (Array.isArray(device.params.switches)) {
                           platform.externalMultiLightUpdate(device.deviceid + "SW0", device.params);
                           return;
                        }
                     }
                     //*** SINGLE SWITCHES ***//      
                     else if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                        if (device.params.hasOwnProperty("switch")) {
                           platform.externalSingleSwitchUpdate(device.deviceid + "SWX", device.params);
                           return;
                        }
                     }
                     //*** MULTI SWITCHES ***//
                     else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                        if (Array.isArray(device.params.switches)) {
                           platform.externalMultiSwitchUpdate(device.deviceid + "SW0", device.params);
                           return;
                        }
                     }
                     //*** BRIDGES ***//
                     else if (constants.devicesBridge.includes(accessory.context.eweUIID)) {
                        if (Array.isArray(device.params)) {
                           platform.externalBridgeUpdate(device.deviceid + "SW0", device.params);
                           return;
                        }
                     }
                     //*** NOT SUPPORTED ***//
                     else {
                        platform.log.warn("[%s] could not be refreshed as it wasn't found in Homebridge.", device.name);
                     }
                  });
               }
               if (platform.debug) platform.log("Opening web socket for real time updates.");
               platform.ws = new wsc();
               platform.ws.open("wss://" + platform.wsHost + ":8080/api/ws");
               platform.ws.onopen = function (e) {
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
                  if (platform.debug) platform.log.warn("Sending web socket login request. This message is yellow for clarity. It is not an error.\n" + JSON.stringify(payload, null, 2));
               };
               platform.ws.onerror = function (e) {
                  platform.log.error("Web socket error - [%s].", e);
                  platform.log.error("Please try restarting Homebridge so that this plugin can work again.");
               };
               platform.ws.onclose = function (e) {
                  platform.log.warn("Web socket was closed - [%s].", e);
                  platform.log.warn("Web socket will reconnect in a few seconds and then please try the command again.");
                  platform.wsIsOpen = false;
                  if (platform.hbInterval) {
                     clearInterval(platform.hbInterval);
                     platform.hbInterval = null;
                  }
               };
               platform.ws.onmessage = function (m) {
                  if (m === "pong") return;
                  if (platform.debug) platform.log.warn("Web socket message received. This message is yellow for clarity. It is not an error.\n" + JSON.stringify(JSON.parse(m), null, 2));
                  let device;
                  try {
                     device = JSON.parse(m);
                  } catch (e) {
                     platform.log.warn("An error occured reading the web socket message [%s]", e);
                     return;
                  }
                  if (device.hasOwnProperty("action")) {
                     let accessory;
                     let i;
                     if (device.action === "update" && device.hasOwnProperty("params")) {
                        if (platform.devicesInHB.has(device.deviceid + "SWX") || platform.devicesInHB.has(device.deviceid + "SW0")) {
                           if (platform.devicesInHB.has(device.deviceid + "SWX")) accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                           else accessory = platform.devicesInHB.get(device.deviceid + "SW0");
                           if (!accessory.reachable) {
                              platform.log.warn("[%s] has been reported offline so cannot refresh.", accessory.displayName);
                              return;
                           }
                           if (platform.debug) platform.log("[%s] has been found in Homebridge so refresh status.", accessory.displayName);
                           accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                           //*** CUSTOM GROUPS ***//       
                           if (platform.customGroup.has(device.deviceid + "SWX")) {
                              if (platform.customGroup.get(device.deviceid + "SWX").type === "blind" && Array.isArray(device.params.switches)) {
                                 platform.externalBlindUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              } else if (platform.customGroup.get(device.deviceid + "SWX").type === "garageDoor" && (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("pulse"))) {
                                 platform.externalGarageDoorUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** FANS ***//                                         
                           else if (constants.devicesFan.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalFanUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** THERMOSTATS ***//                                   
                           else if (constants.devicesThermostat.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("currentTemperature") || device.params.hasOwnProperty("currentHumidity") || device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("masterSwitch")) {
                                 platform.externalThermostatUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** OUTLETS ***//  
                           else if (constants.devicesOutlet.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalOutletUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** LIGHTS [SINGLE SWITCH] ***//      
                           else if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID) && constants.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
                              if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state") || device.params.hasOwnProperty("bright") || device.params.hasOwnProperty("colorR") || device.params.hasOwnProperty("brightness") || device.params.hasOwnProperty("channel0") || device.params.hasOwnProperty("channel2") || device.params.hasOwnProperty("zyx_mode")) {
                                 platform.externalSingleLightUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** LIGHTS [MULTI SWITCH] ***//
                           else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID) && constants.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiLightUpdate(device.deviceid + "SW0", device.params);
                                 return;
                              }
                           }
                           //*** SINGLE SWITCHES ***//
                           else if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("switch")) {
                                 platform.externalSingleSwitchUpdate(device.deviceid + "SWX", device.params);
                                 return;
                              }
                           }
                           //*** MULTI SWITCHES ***//
                           else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
                              if (Array.isArray(device.params.switches)) {
                                 platform.externalMultiSwitchUpdate(device.deviceid + "SW0", device.params);
                                 return;
                              }
                           }
                           //*** BRIDGES ***//
                           else if (constants.devicesBridge.includes(accessory.context.eweUIID)) {
                              if (device.params.hasOwnProperty("cmd") && device.params.cmd === "trigger") {
                                 platform.externalBridgeUpdate(device.deviceid + "SW0", device.params);
                                 return;
                              }
                           }
                           if (device.params.hasOwnProperty("power") || device.params.hasOwnProperty("rssi") || device.params.hasOwnProperty("uiActive") || device.params.hasOwnProperty("sledOnline")) {
                              if (platform.debug) platform.log("[%s] has sent an update which is useless to Homebridge.", accessory.displayName);
                              return;
                           }
                        } else {
                           platform.log.warn("[%s] Accessory received via web socket does not exist in Homebridge. If it's a new accessory please restart Homebridge so it is added.", device.name);
                        }
                     } else if (device.action === "sysmsg") {
                        if (platform.devicesInHB.has(device.deviceid + "SWX")) {
                           try {
                              accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                              accessory.reachable = device.params.online;
                              platform.log("[%s] has been reported [%s].", accessory.displayName, accessory.reachable ? "online" : "offline");
                              platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
                              platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
                           } catch (e) {
                              platform.log.warn("[%s] new status cannot be updated - [%s].", accessory.displayName, e);
                           }
                        } else if (platform.devicesInHB.has(device.deviceid + "SW0")) {
                           let otherAccessory;
                           for (i = 0; i <= accessory.context.channelCount; i++) {
                              try {
                                 otherAccessory = platform.devicesInHB.get(device.deviceid + "SW" + i);
                                 otherAccessory.reachable = device.params.online;
                                 platform.log("[%s] has been reported [%s].", otherAccessory.displayName, otherAccessory.reachable ? "online" : "offline");
                                 platform.devicesInHB.set(otherAccessory.context.hbDeviceId, otherAccessory);
                                 platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [otherAccessory]);
                              } catch (e) {
                                 platform.log.warn("[%s] new status cannot be updated - [%s].", otherAccessory.displayName, e);
                              }
                           }
                        }
                     } else {
                        if (platform.debug) platform.log.warn("[%s] unknown action or parameters received via web socket.", device.name);
                     }
                  } else if (device.hasOwnProperty("config") && device.config.hb && device.config.hbInterval) {
                     if (!platform.hbInterval) {
                        platform.hbInterval = setInterval(function () {
                           platform.ws.send("ping");
                        }, device.config.hbInterval * 1000);
                     }
                  } else {
                     if (platform.debug) platform.log.warn("Unknown command received via web socket.");
                  }
               };
               platform.log("Plugin initialisation has been successful.");
            });
         };
         platform.httpGetHost(function () {
            platform.httpLogin(afterLogin.bind(platform));
         }.bind(platform));
      }.bind(platform));
   }
   addAccessory(device, hbDeviceId, service) {
      if (platform.devicesInHB.get(hbDeviceId)) return; // device is already in Homebridge.
      let channelCount = service === "bridge" ? Object.keys(device.params.rfList).length : constants.chansFromUiid[device.uiid];
      let group;
      let switchNumber = hbDeviceId.substr(-1);
      let newDeviceName = device.name;
      if (!["0", "X"].includes(switchNumber)) newDeviceName += " SW" + switchNumber;
      const accessory = new Accessory(newDeviceName, UUIDGen.generate(hbDeviceId).toString());
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, hbDeviceId);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.brandName);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.productModel + " (" + device.extra.extra.model + ")");
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);
      accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
      accessory.context.hbDeviceId = hbDeviceId;
      accessory.context.eweDeviceId = hbDeviceId.slice(0, -3);
      accessory.context.eweUIID = device.uiid;
      accessory.context.eweModel = device.productModel;
      accessory.context.eweApiKey = device.apikey;
      accessory.context.switchNumber = switchNumber;
      accessory.context.channelCount = channelCount;
      accessory.reachable = true;
      accessory.on("identify", function (paired, callback) {
         platform.log("[%s] identified. Identification on device not supported.", accessory.displayName);
         try {
            callback();
         } catch (e) {}
      });
      switch (service) {
      case "blind":
         accessory.addService(Service.WindowCovering).setCharacteristic(Characteristic.CurrentPosition, 0);
         accessory.getService(Service.WindowCovering).setCharacteristic(Characteristic.TargetPosition, 0);
         accessory.getService(Service.WindowCovering).setCharacteristic(Characteristic.PositionState, 2);
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
            .on("set", function (value, callback) {
               platform.internalBlindUpdate(accessory, value, callback);
            });
         group = platform.customGroup.get(accessory.context.hbDeviceId);
         accessory.context.switchUp = group.switchUp || 0;
         accessory.context.switchDown = group.switchDown || 1;
         accessory.context.durationUp = group.timeUp || 40;
         accessory.context.durationDown = group.timeDown || 20;
         accessory.context.durationBMU = group.timeBottomMarginUp || 0;
         accessory.context.durationBMD = group.timeBottomMarginDown || 0;
         accessory.context.fullOverdrive = 0;
         accessory.context.percentDurationDown = accessory.context.durationDown * 10;
         accessory.context.percentDurationUp = accessory.context.durationUp * 10;
         break;
      case "garageDoor":
         accessory.addService(Service.GarageDoorOpener).setCharacteristic(Characteristic.CurrentDoorState, 1);
         accessory.getService(Service.GarageDoorOpener).setCharacteristic(Characteristic.TargetDoorState, 1);
         accessory.getService(Service.GarageDoorOpener).setCharacteristic(Characteristic.ObstructionDetected, false);
         accessory.context.eweInch = 0;
         if (device.params.hasOwnProperty("pulse") && device.params.hasOwnProperty("pulseWidth")) {
            if (device.params.pulse === "on" && device.params.pulseWidth > 0) {
               accessory.context.eweInch = device.params.pulseWidth;
            }
         }
         accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.TargetDoorState)
            .on("set", function (value, callback) {
               platform.internalGarageDoorUpdate(accessory, value, callback);
            });
         break;
      case "fan":
         accessory.addService(Service.Fan).setCharacteristic(Characteristic.Active, 1);
         accessory.addService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "light", value, callback);
            });
         accessory.getService(Service.Fan).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "power", value, callback);
            });
         accessory.getService(Service.Fan).getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
               minStep: 3
            })
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "speed", value, callback);
            });
         break;
      case "thermostat":
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalThermostatUpdate(accessory, value, callback);
            });
         accessory.addService(Service.TemperatureSensor);
         if (device.params.sensorType !== "DS18B20") accessory.addService(Service.HumiditySensor);
         break;
      case "outlet":
         accessory.addService(Service.Outlet).setCharacteristic(Characteristic.OutletInUse, true);
         accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalOutletUpdate(accessory, value, callback);
            });
         break;
      case "light":
         accessory.addService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value) {
                  platform.internalLightbulbUpdate(accessory, value, callback);
               } else {
                  callback();
               }
            });
         if (constants.devicesBrightable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalBrightnessUpdate(accessory, value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
         } else if (constants.devicesColourable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalHSBUpdate(accessory, "bri", value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
               .on("set", function (value, callback) {
                  if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value !== value) {
                     platform.internalHSBUpdate(accessory, "hue", value, callback);
                  } else {
                     callback();
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
               .on("set", function (value, callback) {
                  accessory.getService(Service.Lightbulb).setCharacteristic(Characteristic.Saturation, value);
                  callback();
               });
         }
         break;
      case "switch":
         accessory.addService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalSwitchUpdate(accessory, value, callback);
            });
         break;
      case "bridge":
         accessory.addService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
         break;
      default:
         platform.log.warn("[%s] cannot be added as it isn't supported by this plugin.", accessory.deviceName);
         return;
      }
      try {
         platform.devicesInHB.set(hbDeviceId, accessory);
         platform.api.registerPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         if (platform.debug) platform.log("[%s] has been added to Homebridge.", newDeviceName);
      } catch (e) {
         platform.log.warn("[%s] cannot be added - [%s].", accessory.displayName, e);
      }
   }
   configureAccessory(accessory) {
      if (!platform.log) return;
      if (accessory.getService(Service.WindowCovering)) {
         accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
            .on("set", function (value, callback) {
               platform.internalBlindUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.GarageDoorOpener)) {
         accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.TargetDoorState)
            .on("set", function (value, callback) {
               platform.internalGarageDoorUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.Fan)) {
         accessory.getService(Service.Fan).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "power", value, callback);
            });
         accessory.getService(Service.Fan).getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
               minStep: 3
            })
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "speed", value, callback);
            });
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalFanUpdate(accessory, "light", value, callback);
            });
      } else if (constants.devicesThermostat.includes(accessory.context.eweUIID)) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalThermostatUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.Outlet)) {
         accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalOutletUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.Lightbulb)) {
         accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value) {
                  platform.internalLightbulbUpdate(accessory, value, callback);
               } else {
                  callback();
               }
            });
         if (constants.devicesBrightable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalBrightnessUpdate(accessory, value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
         } else if (constants.devicesColourable.includes(accessory.context.eweUIID)) {
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
               .on("set", function (value, callback) {
                  if (value > 0) {
                     if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, true, callback);
                     }
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value) {
                        platform.internalHSBUpdate(accessory, "bri", value, callback);
                     } else {
                        callback();
                     }
                  } else {
                     if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                        platform.internalLightbulbUpdate(accessory, false, callback);
                     } else {
                        callback();
                     }
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
               .on("set", function (value, callback) {
                  if (accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value !== value) {
                     platform.internalHSBUpdate(accessory, "hue", value, callback);
                  } else {
                     callback();
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
               .on("set", function (value, callback) {
                  accessory.getService(Service.Lightbulb).setCharacteristic(Characteristic.Saturation, value);
                  callback();
               });
         }
      } else if (accessory.getService(Service.Switch)) {
         accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
            .on("set", function (value, callback) {
               platform.internalSwitchUpdate(accessory, value, callback);
            });
      } else if (accessory.getService(Service.MotionSensor)) {
         accessory.getService(Service.MotionSensor).setCharacteristic(Characteristic.MotionDetected, false);
      } else {
         platform.log.warn("[%s] could not be refreshed due to unknown accessory type.", accessory.displayName);
         return;
      }
      try {
         accessory.reachable = true;
         platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
         platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
      } catch (e) {
         platform.log.warn("[%s] cannot be refreshed - [%s].", accessory.displayName, e);
      }
   }
   internalBlindUpdate(accessory, value, callback) {
      if (platform.debug) platform.log("[%s] updating target position to [%s].", accessory.displayName, value);
      let cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
      let tPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).value;
      let cSte = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.PositionState).value;
      let timestamp = Date.now();
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.hbDeviceId,
         params: {
            lock: 0,
            zyx_clear_timers: false,
            configure: [{
                  "startup": "off",
                  "outlet": 0
               },
               {
                  "startup": "off",
                  "outlet": 1
               },
               {
                  "startup": "off",
                  "outlet": 2
               },
               {
                  "startup": "off",
                  "outlet": 3
               }
            ],
            "pulses": [{
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 0
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 1
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 2
               },
               {
                  "pulse": "off",
                  "width": 1000,
                  "outlet": 3
               }
            ],
            "switches": [{
                  "switch": "off",
                  "outlet": 0
               },
               {
                  "switch": "off",
                  "outlet": 1
               },
               {
                  "switch": "off",
                  "outlet": 2
               },
               {
                  "switch": "off",
                  "outlet": 3
               }
            ]
         }
      };
      if (cSte < 2) { // ie it's currently moving [either up or down]
         let diffPosition = Math.abs(value - tPos);
         let actualPosition = value;
         let diffTime = 0;
         let diff = 0;
         if (diffPosition > 0) {
            if (cSte === 1) {
               diffPosition = tPos - value;
               diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
               actualPosition = Math.round(cPos - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
            } else {
               diffPosition = value - tPos;
               diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
               actualPosition = Math.round(cPos + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
            }
            diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
            if (diff > 0) {
               accessory.context.targetTimestamp += diffTime;
               if (value === 0 || value === 100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
               callback();
               return;
            }
            if (diff < 0) {
               accessory.context.startTimestamp = timestamp;
               accessory.context.targetTimestamp = timestamp + Math.abs(diff);
               if (value === 0 || value === 100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, actualPosition);
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, cSte === 0 ? 1 : 0);
               payload.params.switches[accessory.context.switchUp].switch = cSte === 1 ? "on" : "off";
               payload.params.switches[accessory.context.switchDown].switch = cSte === 0 ? "on" : "off";
               platform.wsSendUpdate(payload, function () {
                  return;
               });
            }
            callback();
            return;
         }
         callback();
         return;
      }
      if (cPos === value) {
         callback();
         return;
      }
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, value);
      let moveUp = (value > cPos);
      let duration;
      if (moveUp) {
         duration = (value - cPos) / 100 * (accessory.context.durationUp - accessory.context.durationBMU);
         if (cPos === 0) duration += accessory.context.durationBMU;
      } else {
         duration = (cPos - value) / 100 * (accessory.context.durationDown - accessory.context.durationBMD);
         if (value === 0) duration += accessory.context.durationBMD;
      }
      if (value === 0 || value === 100) duration += accessory.context.fullOverdrive;
      duration = Math.round(duration * 100) / 100;
      accessory.context.startTimestamp = timestamp;
      accessory.context.targetTimestamp = timestamp + (duration * 1000);
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, moveUp ? 0 : 1);
      payload.params.switches[accessory.context.switchUp].switch = moveUp ? "on" : "off";
      payload.params.switches[accessory.context.switchDown].switch = moveUp ? "off" : "on";
      platform.wsSendUpdate(payload, function () {
         return;
      });
      let interval = setInterval(function () {
         if (Date.now() >= accessory.context.targetTimestamp) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
            payload.params.switches[accessory.context.switchUp].switch = "off";
            payload.params.switches[accessory.context.switchDown].switch = "off";
            setTimeout(function () {
               platform.wsSendUpdate(payload, function () {
                  return;
               });
               accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, value);
               return;
            }, 500);
            clearInterval(interval);
            return;
         }
      }, 100);
      callback();
   }
   internalGarageDoorUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {
            switch: "on"
         }
      };
      if (platform.debug) platform.log("[%s] updating garage door to [%s].", accessory.displayName, value === 0 ? "open" : "close");
      platform.wsSendUpdate(payload, function () {
         return;
      });
      accessory.getService(Service.GarageDoorOpener).updateCharacteristic(Characteristic.TargetDoorState, value === 0 ? 0 : 1);
      accessory.getService(Service.GarageDoorOpener).updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 2 : 3);
      if (accessory.context.eweInch === 0) {
         setTimeout(function () {
            payload.params.switch = "off";
            platform.wsSendUpdate(payload, function () {
               return;
            });
         }, 500);
      }
      setTimeout(function () {
         accessory.getService(Service.GarageDoorOpener).updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 0 : 1);
      }, 5000);
      callback();
   }
   internalFanUpdate(accessory, type, value, callback) {
      let newPower;
      let newSpeed;
      let newLight;
      switch (type) {
      case "power":
         newPower = value;
         newSpeed = value ? 33 : 0;
         newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
         break;
      case "speed":
         newPower = value >= 33;
         newSpeed = value;
         newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
         break;
      case "light":
         newPower = accessory.getService(Service.Fan).getCharacteristic(Characteristic.On).value;
         newSpeed = accessory.getService(Service.Fan).getCharacteristic(Characteristic.RotationSpeed).value;
         newLight = value;
         break;
      }
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
      payload.params.switches[0].switch = newLight ? "on" : "off";
      payload.params.switches[1].switch = newSpeed >= 33 ? "on" : "off";
      payload.params.switches[2].switch = newSpeed >= 66 && newSpeed < 99 ? "on" : "off";
      payload.params.switches[3].switch = newSpeed >= 99 ? "on" : "off";
      if (platform.debug) platform.log("[%s] updating [%s] to [%s].", accessory.displayName, type, value);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newLight);
      accessory.getService(Service.Fan).updateCharacteristic(Characteristic.On, newPower);
      accessory.getService(Service.Fan).updateCharacteristic(Characteristic.RotationSpeed, newSpeed);
      platform.wsSendUpdate(payload, callback);
   }
   internalThermostatUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {
            switch: value ? "on" : "off",
            mainSwitch: value ? "on" : "off"
         }
      };
      if (platform.debug) platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
      platform.wsSendUpdate(payload, callback);
   }
   internalOutletUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {
            switch: value ? "on" : "off"
         }
      };
      if (platform.debug) platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, value);
      platform.wsSendUpdate(payload, callback);
   }
   internalLightbulbUpdate(accessory, value, callback) {
      let otherAccessory;
      let i;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (accessory.context.switchNumber) {
      case "X":
         if (accessory.context.eweUIID === 22) { // The B1 uses state instead of switch for some strange reason.
            payload.params.state = value ? "on" : "off";
         } else {
            payload.params.switch = value ? "on" : "off";
         }
         if (platform.debug) platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         break;
      case "0":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = value ? "on" : "off";
         payload.params.switches[1].switch = value ? "on" : "off";
         payload.params.switches[2].switch = value ? "on" : "off";
         payload.params.switches[3].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
               otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            }
         }
         break;
      case "1":
      case "2":
      case "3":
      case "4":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = value ? "on" : "off";
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
         let ch = false;
         let masterState = "off";
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               ch = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i).getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
               if (ch) {
                  masterState = "on";
               }
            }
         }
         if (platform.debug) platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
         otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState === "on");
         break;
      default:
         callback();
         return;
      }
      platform.wsSendUpdate(payload, callback);
   }
   internalBrightnessUpdate(accessory, value, callback) {
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      if (value === 0) {
         payload.params.switch = "off";
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
      } else {
         if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
            payload.params.switch = "on";
         }
         if (accessory.context.eweUIID === 36) { // KING-M4
            payload.params.bright = Math.round(value * 9 / 10 + 10);
         } else if (accessory.context.eweUIID === 44) { // D1
            payload.params.brightness = value;
            payload.params.mode = 0;
         } else {
            callback();
            return;
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
      }
      if (platform.debug) platform.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
      setTimeout(function () {
         platform.wsSendUpdate(payload, callback);
      }, 250);
   }
   internalHSBUpdate(accessory, type, value, callback) {
      let newRGB;
      let curHue;
      let curSat;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (type) {
      case "hue":
         curSat = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
         newRGB = convert.hsv.rgb(value, curSat, 100);
         if ((accessory.context.eweUIID === 22)) { // B1
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0];
            payload.params.channel3 = newRGB[1];
            payload.params.channel4 = newRGB[2];
         } else if (accessory.context.eweUIID === 59) { // L1
            payload.params.mode = 1;
            payload.params.colorR = newRGB[0];
            payload.params.colorG = newRGB[1];
            payload.params.colorB = newRGB[2];
         } else {
            callback();
            return;
         }
         if (platform.debug) platform.log("[%s] updating hue to [%s].", accessory.displayName, value);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, value);
         break;
      case "bri":
         curHue = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value;
         curSat = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
         if (accessory.context.eweUIID === 22) { // B1
            newRGB = convert.hsv.rgb(curHue, curSat, value);
            payload.params.zyx_mode = 2;
            payload.params.channel2 = newRGB[0];
            payload.params.channel3 = newRGB[1];
            payload.params.channel4 = newRGB[2];
         } else if (accessory.context.eweUIID === 59) { // L1
            payload.params.mode = 1;
            payload.params.bright = value;
         } else {
            callback();
            return;
         }
         if (platform.debug) platform.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
         break;
      }
      setTimeout(function () {
         platform.wsSendUpdate(payload, callback);
      }, 250);
   }
   internalSwitchUpdate(accessory, value, callback) {
      let otherAccessory;
      let i;
      let payload = {
         apikey: accessory.context.eweApiKey,
         deviceid: accessory.context.eweDeviceId,
         params: {}
      };
      switch (accessory.context.switchNumber) {
      case "X":
         payload.params.switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         break;
      case "0":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = value ? "on" : "off";
         payload.params.switches[1].switch = value ? "on" : "off";
         payload.params.switches[2].switch = value ? "on" : "off";
         payload.params.switches[3].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
               otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            }
         }
         break;
      case "1":
      case "2":
      case "3":
      case "4":
         payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[parseInt(accessory.context.switchNumber) - 1].switch = value ? "on" : "off";
         if (platform.debug) platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         let ch = false;
         let masterState = "off";
         for (i = 1; i <= 4; i++) {
            if (platform.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
               ch = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i).getService(Service.Switch).getCharacteristic(Characteristic.On).value;
               if (ch) {
                  masterState = "on";
               }
            }
         }
         otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
         otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState === "on");
         break;
      default:
         callback();
         return;
      }
      platform.wsSendUpdate(payload, callback);
   }
   externalBlindUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
      let tPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).value;
      let cSte = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.PositionState).value;
      let switchUp = params.switches[accessory.context.switchUp].switch === "on" ? 2 : 0;
      let switchDown = params.switches[accessory.context.switchDown].switch === "on" ? 1 : 0;
      let state;
      switch (switchUp + switchDown) {
      case 0:
      default:
         state = 2; // stopped or error
         break;
      case 1:
         state = 1; // moving down
         break;
      case 2:
         state = 0; // moving up
         break;
      }
      accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, state);
      switch (state) {
      case 3:
      case 2:
      default:
         let timestamp = Date.now();
         if (cSte === 2) {
            return;
         } else if (cSte === 1) {
            cPos = Math.round(cPos - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
         } else if (cSte === 0) {
            cPos = Math.round(cPos + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
         }
         accessory.context.targetTimestamp = Date.now() + 10;
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, cPos);
         break;
      case 1:
         if (cSte === 1) {
            return;
         }
         if (tPos !== 0) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 0);
         }
         break;
      case 0:
         if (cSte === 0) {
            return;
         }
         if (tPos != 100) {
            accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, 100);
         }
         break;
      }
      if ((state === 0 && tPos === 0) || (state === 1 && tPos === 100)) {
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.CurrentPosition, tPos);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.TargetPosition, tPos);
         accessory.getService(Service.WindowCovering).updateCharacteristic(Characteristic.PositionState, 2);
      }
   }
   externalGarageDoorUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      if (params.hasOwnProperty("pulse") && params.hasOwnProperty("pulseWidth")) {
         if (params.pulse === "on" && params.pulseWidth > 0) {
            accessory.context.eweInch = params.pulseWidth;
         } else {
            accessory.context.eweInch = 0;
         }
         return;
      }
      if (params.switch !== "on") return;
      let cVal = accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.CurrentDoorState).value;
      accessory.getService(Service.GarageDoorOpener).updateCharacteristic(Characteristic.TargetDoorState, cVal === 0 ? 1 : 0);
      accessory.getService(Service.GarageDoorOpener).updateCharacteristic(Characteristic.CurrentDoorState, cVal === 0 ? 1 : 0);
   }
   externalFanUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[0].switch === "on");
      let status = false;
      let speed = 0;
      if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "off") {
         status = true;
         speed = 33;
      } else if (params.switches[1].switch === "on" && params.switches[2].switch === "on" && params.switches[3].switch === "off") {
         status = true;
         speed = 66;
      } else if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "on") {
         status = true;
         speed = 100;
      }
      accessory.getService(Service.Fan).updateCharacteristic(Characteristic.On, status);
      accessory.getService(Service.Fan).updateCharacteristic(Characteristic.RotationSpeed, speed);
   }
   externalThermostatUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      if (params.hasOwnProperty("switch") || params.hasOwnProperty("mainSwitch")) {
         let newState;
         if (params.hasOwnProperty("switch")) {
            newState = params.switch === "on";
         } else {
            newState = params.mainSwitch === "on";
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, newState);
      }
      if (params.hasOwnProperty("currentTemperature") && accessory.getService(Service.TemperatureSensor)) {
         let currentTemp = params.currentTemperature !== "unavailable" ? params.currentTemperature : 0;
         accessory.getService(Service.TemperatureSensor).updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      }
      if (params.hasOwnProperty("currentHumidity") && accessory.getService(Service.HumiditySensor)) {
         let currentHumi = params.currentHumidity !== "unavailable" ? params.currentHumidity : 0;
         accessory.getService(Service.HumiditySensor).updateCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumi);
      }
   }
   externalOutletUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, params.switch === "on");
   }
   externalSingleLightUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let newColour;
      let mode;
      let isOn = false;
      if ((accessory.context.eweUIID === 22) && params.hasOwnProperty("state")) {
         isOn = params.state === "on";
      } else if (accessory.context.eweUIID !== 22 && params.hasOwnProperty("switch")) {
         isOn = params.switch === "on";
      } else {
         isOn = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
      }
      if (isOn) {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
         switch (accessory.context.eweUIID) {
         case 36: // KING-M4
            if (params.hasOwnProperty("bright")) {
               // Device brightness has a eWeLink scale of 10-100 and HomeKit scale is 0-100.
               let nb = Math.round((params.bright - 10) * 10 / 9);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, nb);
            }
            break;
         case 44: // D1
            if (params.hasOwnProperty("brightness")) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.brightness);
            }
            break;
         case 22: // B1
            if (params.hasOwnProperty("zyx_mode")) mode = parseInt(params.zyx_mode);
            else if (params.hasOwnProperty("channel0")) mode = 1;
            else if (params.hasOwnProperty("channel2")) mode = 2;
            if (mode === 2) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
               newColour = convert.rgb.hsv(parseInt(params.channel2), parseInt(params.channel3), parseInt(params.channel4));
               // The eWeLink app only supports hue change in app so set saturation and brightness to 100.
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, 100);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, 100);
            } else if (mode === 1) {
               platform.log.warn("[%s] has been set to 'white mode' which is not supported by this plugin.", accessory.displayName);
            }
            break;
         case 59: // L1
            if (params.hasOwnProperty("bright")) {
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.bright);
            }
            if (params.hasOwnProperty("colorR")) {
               newColour = convert.rgb.hsv(params.colorR, params.colorG, params.colorB);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, newColour[0]);
               accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, newColour[1]);
            }
            break;
         default:
            return;
         }
      } else {
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
      }
   }
   externalMultiLightUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let i;
      let primaryState = false;
      let otherAccessory;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, params.fwVersion);
            otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
            if (params.switches[i - 1].switch === "on") primaryState = true;
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
      }
   }
   externalSingleSwitchUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switch === "on");
   }
   externalMultiSwitchUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let i;
      let primaryState = false;
      let otherAccessory;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, params.fwVersion);
            otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
            if (params.switches[i - 1].switch === "on") primaryState = true;
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
      }
   }
   externalBridgeUpdate(hbDeviceId, params) {
      let accessory = platform.devicesInHB.get(hbDeviceId);
      let idToCheck = hbDeviceId.slice(0, -1);
      let timeNow = new Date();
      let timeOfMotion;
      let timeDifference;
      let i;
      let otherAccessory;
      let master = false;
      for (i = 1; i <= accessory.context.channelCount; i++) {
         if (platform.devicesInHB.has(idToCheck + i)) {
            otherAccessory = platform.devicesInHB.get(idToCheck + i);
            if (params.hasOwnProperty("rfTrig" + (i - 1))) {
               timeOfMotion = new Date(params["rfTrig" + (i - 1)]);
               timeDifference = (timeNow.getTime() - timeOfMotion.getTime()) / 1000;
               if (timeDifference < platform.sensorTimeDifference) {
                  otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
                  master = true;
                  if (platform.debug) platform.log("[%s] has detected motion.", otherAccessory.displayName);
               }
            }
         }
         accessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, master);
      }
      setTimeout(() => {
         for (i = 0; i <= accessory.context.channelCount; i++) {
            if (platform.devicesInHB.has(idToCheck + i)) {
               otherAccessory = platform.devicesInHB.get(idToCheck + i);
               otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, false);
            }
         }
      }, platform.sensorTimeLength * 1000);
   }
   getSignature(string) {
      return crypto.createHmac("sha256", "6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM").update(string).digest("base64");
   }
   httpGetHost(callback) {
      let data = {
         country_code: platform.config.countryCode,
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
      axios.get("https://api.coolkit.cc:8080/api/user/region", {
         params: data,
         headers: {
            Authorization: "Sign " + platform.getSignature(dataToSign),
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         if (!body.region) throw "Server did not respond with a region.\n" + JSON.stringify(body, null, 2);
         switch (body.region) {
         case "eu":
         case "us":
         case "as":
            platform.apiHost = body.region + "-api.coolkit.cc:8080";
            break;
         case "cn":
            platform.apiHost = "cn-api.coolkit.cn:8080";
            break;
         default:
            throw "No valid region received - [" + body.region + "].";
         }
         if (platform.debug) platform.log("HTTP API host received [%s].", platform.apiHost);
         callback(platform.apiHost);
         return;
      }).catch(function (error) {
         platform.log.error("** Cannot load homebridge-ewelink-sonoff **");
         platform.log.warn(error);
         callback();
         return;
      }.bind(platform));
   }
   httpLogin(callback) {
      let data = {
         password: platform.config.password,
         version: 8,
         ts: Math.floor(new Date().getTime() / 1000),
         nonce: nonce(),
         appid: constants.appId
      };
      if (platform.config.username.includes("@")) data.email = platform.config.username;
      else data.phoneNumber = platform.config.username;
      if (platform.debug) platform.log.warn("Sending HTTP login request. This message is yellow for clarity. It is not an error.\n" + JSON.stringify(data, null, 2));
      axios({
         method: "post",
         url: "https://" + platform.apiHost + "/api/user/login",
         data: data,
         headers: {
            Authorization: "Sign " + platform.getSignature(JSON.stringify(data)),
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         if (!body.at) throw "Server did not respond with an authentication token. Please double check your eWeLink username and password in the Homebridge configuration.\n" + JSON.stringify(body, null, 2);
         platform.aToken = body.at;
         platform.apiKey = body.user.apikey;
         if (platform.debug) {
            platform.log("Authorisation token received [%s].", platform.aToken);
            platform.log("User API key received [%s].", platform.apiKey);
         }
         platform.wsGetHost(function () {
            callback(platform.aToken);
         }.bind(platform));
      }).catch(function (error) {
         platform.log.error("** Cannot load homebridge-ewelink-sonoff **");
         platform.log.warn(error);
         callback();
         return;
      }.bind(platform));
   }
   wsGetHost(callback) {
      axios({
         method: "post",
         url: "https://" + platform.apiHost.replace("-api", "-disp") + "/dispatch/app",
         data: {
            accept: "mqtt,ws",
            version: 8,
            ts: Math.floor(new Date().getTime() / 1000),
            nonce: nonce(),
            appid: constants.appId
         },
         headers: {
            Authorization: "Bearer " + platform.aToken,
            "Content-Type": "application/json;charset=UTF-8"
         }
      }).then((res) => {
         let body = res.data;
         if (!body.domain) throw "Server did not respond with a web socket host.";
         if (platform.debug) platform.log("Web socket host received [%s].", body.domain);
         platform.wsHost = body.domain;
         callback(platform.wsHost);
      }).catch(function (error) {
         platform.log.error("** Cannot load homebridge-ewelink-sonoff **");
         platform.log.warn("No web socket host - %s.", error);
         callback();
         return;
      }.bind(platform));
   }
   wsSendUpdate(json, callback) {
      json.sequence = Math.floor(new Date());
      json.action = "update";
      json.userAgent = "app";
      let string = JSON.stringify(json);
      platform.delaySend = 0;
      let sendOperation = (string) => {
         if (!platform.wsIsOpen) {
            setTimeout(() => {
               sendOperation(string);
            }, 280);
            return;
         }
         if (platform.ws) {
            try {
               platform.ws.send(string);
            } catch (e) {
               platform.ws.emit("error", e);
            }
            if (platform.debug) platform.log.warn("Web socket message sent. This message is yellow for clarity. It is not an error.\n" + JSON.stringify(json, null, 2));
            callback();
         }
         platform.delaySend = platform.delaySend <= 0 ? 0 : platform.delaySend -= 280;
      };
      if (platform.wsIsOpen) {
         setTimeout(sendOperation, platform.delaySend, string);
         platform.delaySend += 280;
      } else {
         if (platform.debug) platform.log("Web socket is currently reconnecting.");
         let interval;
         let waitToSend = (string) => {
            if (platform.wsIsOpen) {
               clearInterval(interval);
               sendOperation(string);
            }
         };
         interval = setInterval(waitToSend, 750, string);
      }
   }
}
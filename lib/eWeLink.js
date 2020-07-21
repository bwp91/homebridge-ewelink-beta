/* jshint esversion: 9 */
"use strict";
const constants = require("./constants");
const convert = require("color-convert");
const eWeLinkHTTP = require("./eWeLinkHTTP");
const eWeLinkWS = require("./eWeLinkWS");
const eWeLinkLAN = require("./eWeLinkLAN");
let platform, Accessory, Service, Characteristic, UUIDGen;
class eWeLink {
   constructor(log, config, api) {
      if (!log || !api) {
         return;
      }
      if (!config || (!config.username || !config.password || !config.countryCode)) {
         log.error("** Could not load homebridge-ewelink-sonoff **");
         log.warn("Make sure your eWeLink credentials are in the Homebridge configuration.");
         return;
      }
      platform = this;
      platform.log = log;
      platform.config = config;
      platform.api = api;
      platform.debug = true;
      platform.redactLogs = platform.config.redactLogs || true;
      platform.customHideChanFromHB = platform.config.hideFromHB || "";
      platform.customHideDvceFromHB = platform.config.hideDevFromHB || "";
      platform.sensorTimeLength = platform.config.sensorTimeLength || 2;
      platform.sensorTimeDifference = platform.config.sensorTimeDifference || 120;
      platform.devicesInHB = new Map();
      platform.devicesInEwe = new Map();
      platform.customGroups = new Map();
      platform.customBridgeSensors = new Map();
      platform.api.on("didFinishLaunching", function () {
         platform.log("Plugin has finished initialising. Starting synchronisation with eWeLink account.");
         //*** SET UP HTTP API CLIENT AND GET THE USER HTTP API HOST ***\\
         platform.httpClient = new eWeLinkHTTP(platform.config, platform.log, platform.debug, platform.redactLogs);
         platform.httpClient.getHost()
            .then(res => {
               //*** USE THE HTTP API HOST TO LOG INTO EWELINK ***\\
               platform.apiHost = res;
               return platform.httpClient.login();
            }).then(res => {
               //*** SET UP THE WEB SOCKET CLIENT ***\\
               platform.apiKey = res.apiKey;
               platform.aToken = res.aToken;
               platform.wsClient = new eWeLinkWS(platform.log, platform.apiHost, platform.aToken, platform.apiKey, platform.debug, platform.redactLogs);
               return platform.wsClient.getHost();
            }).then(res => {
               //*** USE THE WEB SOCKET HOST TO OPEN CONNECTION ***\\
               platform.wsHost = res;
               platform.wsClient.login();
               //*** REQUEST A DEVICE LIST VIA HTTP API ***\\
               return platform.httpClient.getDevices();
            }).then(res => {
               platform.httpDevices = res;
               //*** LAN MODE GET IP ADDRESSES ***\\
               platform.lanClient = new eWeLinkLAN(platform.log, platform.debug, platform.redactLogs);
               return platform.lanClient.getHosts();
            }).then(res => {
               platform.lanDevices = res;
               //*** SET UP THE LAN MODE LISTENER ***\\
               return platform.lanClient.startMonitor();
            }).then(res => {
               if (platform.debug) {
                  platform.log("Future LAN mode support:\n" + JSON.stringify(platform.lanDevices, null, 2));
               }
               //*** USE THE DEVICE LIST TO REFRESH HOMEBRIDGE ACCESSORIES ***\\
               (function () {
                  //*** REMOVE ALL HOMEBRIDGE ACCESSORIES IF NONE FOUND ***\\
                  if (Object.keys(platform.httpDevices).length === 0 && Object.keys(platform.lanDevices).length === 0) {
                     platform.removeAllAccessories();
                     return;
                  }
                  //*** MAKE A MAP OF COMPATIBLE DEVICES FROM EWELINK ***\\
                  platform.httpDevices.forEach(device => {
                     if (device.type !== "10" || platform.customHideDvceFromHB.includes(device.deviceid)) {
                        return;
                     }
                     platform.devicesInEwe.set(device.deviceid, device);
                  });
                  //*** MAKE A MAP OF CUSTOM GROUPS FROM THE HOMEBRIDGE CONFIG ***\\
                  if (platform.config.groups && Object.keys(platform.config.groups).length > 0) {
                     platform.config.groups.forEach(group => {
                        if (typeof group.deviceId !== "undefined" && platform.devicesInEwe.has(group.deviceId.toLowerCase())) {
                           platform.customGroups.set(group.deviceId + "SWX", group);
                        }
                     });
                  }
                  //*** MAKE A MAP OF CUSTOM RF BRIDGE SENSORS FROM THE HOMEBRIDGE CONFIG ***\\
                  if (platform.config.bridgeSensors && Object.keys(platform.config.bridgeSensors).length > 0) {
                     platform.config.bridgeSensors.forEach(bridgeSensor => {
                        if (typeof bridgeSensor.deviceId !== "undefined" && platform.devicesInEwe.has(bridgeSensor.deviceId.toLowerCase())) {
                           platform.customBridgeSensors.set(bridgeSensor.fullDeviceId, bridgeSensor);
                        }
                     });
                  }
                  //*** DO SOME LOGGING FOR AN EASY CHECK THAT EVERYTHING APPEARS OKAY ***\\
                  platform.log("[%s] eWeLink devices were loaded from the Homebridge cache.", platform.devicesInHB.size);
                  platform.log("[%s] primary devices were loaded from your eWeLink account.", platform.devicesInEwe.size);
                  platform.log("[%s] primary devices were discovered on your local network.", Object.keys(platform.lanDevices).length);
                  platform.log("[%s] custom groups were loaded from the configuration.", platform.customGroups.size);
                  //*** REMOVE ANY INDIVIDUAL ACCESSORIES THAT DON'T APPEAR IN EWELINK ***\\
                  if (platform.devicesInHB.size > 0) {
                     platform.devicesInHB.forEach(accessory => {
                        if (!platform.devicesInEwe.has(accessory.context.eweDeviceId)) {
                           platform.removeAccessory(accessory);
                        }
                     });
                  }
                  //*** NO DEVICES IN EWELINK MEANS NO REASON TO LOAD PLUGIN ***\\
                  if (platform.devicesInEwe.size === 0) {
                     return;
                  }
                  //*** ADD AND REFRESH REMAINING DEVICES THAT MATCH IN EWELINK AND HOMEBRIDGE ***\\
                  platform.devicesInEwe.forEach(device => {
                     platform.initialiseDevice(device);
                  });
                  //*** SET UP THE WEB SOCKET LISTENER FOR FUTURE EXTERNAL DEVICE UPDATES ***\\
                  platform.wsClient.receiveUpdate(device => {
                     platform.externalDeviceUpdate(device);
                  });
                  //*** SET UP THE LAN MODE LISTENER FOR FUTURE EXTERNAL DEVICE UPDATES ***\\
                  platform.lanClient.receiveUpdate(device => {
                     platform.externalLANUpdate(device);
                  });
                  //*** PHEW WE ARE HERE. SO MUCH THAT COULD HAVE GONE WRONG BUT ALL GOOD! ***\\
                  //*** platform.log.hooray("Plugin initialisation has been successful."); ***\\
                  platform.log("Synchronisation complete. Ready to go!");
               })();
            }).catch(err => {
               platform.log.error("** eWeLink synchronisation error: **");
               platform.log.warn(err);
               platform.log.error("** Plugin will not be loaded. **");
            });
      });
   }
   initialiseDevice(device) {
      let accessory;
      if (!platform.devicesInHB.has(device.deviceid + "SWX") && !platform.devicesInHB.has(device.deviceid + "SW0")) {
         if (platform.customGroups.has(device.deviceid + "SWX")) {
            //*** ADD BLINDS ***\\
            if (platform.customGroups.get(device.deviceid + "SWX").type === "cusBlind" && Array.isArray(device.params.switches)) {
               platform.addAccessory(device, device.deviceid + "SWX", "cusBlind");
            }
            //*** ADD GARAGES ***\\
            else if (platform.customGroups.get(device.deviceid + "SWX").type === "cusGarage" && device.params.hasOwnProperty("switch")) {
               platform.addAccessory(device, device.deviceid + "SWX", "cusGarage");
            }
         }
         //*** ADD SENSORS ***\\
         else if (constants.devicesSensor.includes(device.uiid)) {
            if (device.params.hasOwnProperty("switch")) {
               platform.addAccessory(device, device.deviceid + "SWX", "sensor");
            }
         }
         //*** ADD FANS ***\\
         else if (constants.devicesFan.includes(device.uiid)) {
            if (Array.isArray(device.params.switches)) {
               platform.addAccessory(device, device.deviceid + "SWX", "fan");
            }
         }
         //*** ADD THERMOSTATS ***\\
         else if (constants.devicesThermostat.includes(device.uiid)) {
            if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("mainSwitch")) {
               platform.addAccessory(device, device.deviceid + "SWX", "thermostat");
            }
         }
         //*** ADD OUTLETS ***\\
         else if (constants.devicesOutlet.includes(device.uiid)) {
            if (device.params.hasOwnProperty("switch")) {
               platform.addAccessory(device, device.deviceid + "SWX", "outlet");
            }
         }
         //*** ADD SINGLE LIGHTS ***\\
         else if (constants.devicesSingleSwitch.includes(device.uiid) && constants.devicesSingleSwitchLight.includes(device.productModel)) {
            if (device.params.hasOwnProperty("switch") || device.params.hasOwnProperty("state")) {
               platform.addAccessory(device, device.deviceid + "SWX", "light");
            }
         }
         //*** ADD MULTI LIGHTS ***\\
         else if (constants.devicesMultiSwitch.includes(device.uiid) && constants.devicesMultiSwitchLight.includes(device.productModel)) {
            if (Array.isArray(device.params.switches)) {
               for (let i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
                  platform.addAccessory(device, device.deviceid + "SW" + i, "light");
               }
            }
         }
         //*** ADD SINGLE SWITCHES ***\\
         else if (constants.devicesSingleSwitch.includes(device.uiid)) {
            if (device.params.hasOwnProperty("switch")) {
               platform.addAccessory(device, device.deviceid + "SWX", "switch");
            }
         }
         //*** ADD MULTI SWITCHES ***\\
         else if (constants.devicesMultiSwitch.includes(device.uiid)) {
            if (Array.isArray(device.params.switches)) {
               for (let i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
                  platform.addAccessory(device, device.deviceid + "SW" + i, "switch");
               }
            }
         }
         //*** ADD BRIDGES ***\\
         else if (constants.devicesBridge.includes(device.uiid)) {
            if (device.params.hasOwnProperty("rfList")) {
               for (let i = 0; i <= Object.keys(device.params.rfList).length; i++) {
                  platform.addAccessory(device, device.deviceid + "SW" + i, "bridge");
               }
            }
         }
         //*** ADD NOT SUPPORTED ***\\
         else {
            platform.log.warn("[%s] could not be added as it is not supported by this plugin.", device.name);
         }
      }
      //*** REFRESH DEVICES ***\\
      if ((accessory = platform.devicesInHB.get(device.deviceid + "SWX"))) {
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
         // accessory.context.reachableLAN = platform.lanDevices[device.deviceid] || false;
         accessory.context.reachableWAN = device.online;
         if (accessory.context.eweUIID === 102) {
            accessory.context.reachableWAN = true;
         }
         try {
            platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
            platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         } catch (e) {
            platform.log.warn("[%s] online/offline status could not be updated - [%s].", accessory.displayName, e);
         }
      } else if ((accessory = platform.devicesInHB.get(device.deviceid + "SW0"))) {
         for (let i = 0; i <= accessory.context.channelCount; i++) {
            let otherAccessory;
            try {
               if (!platform.devicesInHB.has(device.deviceid + "SW" + i)) {
                  if ([1, 2, 3, 4].includes(i) && platform.customHideChanFromHB.includes(device.deviceid + "SW" + i) && accessory.context.type === "switch") {
                     continue;
                  } else {
                     platform.addAccessory(device, device.deviceid + "SW" + i, "switch");
                  }
               }
               otherAccessory = platform.devicesInHB.get(device.deviceid + "SW" + i);
               if ([1, 2, 3, 4].includes(i) && platform.customHideChanFromHB.includes(device.deviceid + "SW" + i) && accessory.context.type === "switch") {
                  platform.removeAccessory(otherAccessory);
                  continue;
               }
               otherAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
               otherAccessory.context.reachableWAN = device.online;
               // otherAccessory.context.reachableLAN = platform.lanDevices[device.deviceid] || false;
               platform.devicesInHB.set(otherAccessory.context.hbDeviceId, otherAccessory);
               platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [otherAccessory]);
            } catch (e) {}
         }
      } else {
         platform.log.warn("[%s] will not be refreshed as it wasn't found in Homebridge.", device.name);
         return;
      }
      // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
      if (!accessory.context.reachableWAN) {
         platform.log.warn("[%s] will not be refreshed as it has been reported offline.", accessory.displayName);
         return;
      }
      if (!platform.refreshAccessory(accessory, device.params)) {
         platform.log.error("[%s] will not be refreshed due to missing type parameter.\nPlease remove [%s] from the Homebridge cache (including any secondary devices (SW1, SW2, etc.).", accessory.displayName, accessory.displayName);
      }
   }
   addAccessory(device, hbDeviceId, service) {
      let channelCount = service === "bridge" ? Object.keys(device.params.rfList).length : constants.chansFromUiid[device.uiid];
      let switchNumber = hbDeviceId.substr(-1).toString();
      let newDeviceName = device.name;
      if (["1", "2", "3", "4"].includes(switchNumber)) {
         newDeviceName += " SW" + switchNumber;
         if (platform.customHideChanFromHB.includes(hbDeviceId) && service === "switch") {
            platform.log.warn("[%s] has not been added as per user configuration", newDeviceName);
            return;
         }
      }
      const accessory = new Accessory(newDeviceName, UUIDGen.generate(hbDeviceId).toString());
      try {
         accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.SerialNumber, hbDeviceId)
            .setCharacteristic(Characteristic.Manufacturer, device.brandName)
            .setCharacteristic(Characteristic.Model, device.productModel + " (" + device.extra.extra.model + ")")
            .setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion)
            .setCharacteristic(Characteristic.Identify, false);
         accessory.on("identify", function (paired, callback) {
            platform.log("[%s] identified.", accessory.displayName);
            callback();
         });
         accessory.context = {
            hbDeviceId,
            eweDeviceId: hbDeviceId.slice(0, -3),
            eweUIID: device.uiid,
            eweModel: device.productModel,
            eweApiKey: device.apikey,
            switchNumber,
            channelCount,
            type: service,
            reachable: true
         };
         switch (service) {
         case "cusBlind":
            accessory.addService(Service.WindowCovering)
               .setCharacteristic(Characteristic.CurrentPosition, 100)
               .setCharacteristic(Characteristic.TargetPosition, 100)
               .setCharacteristic(Characteristic.PositionState, 2);
            break;
         case "cusGarage":
            accessory.addService(Service.GarageDoorOpener)
               .setCharacteristic(Characteristic.CurrentDoorState, 1)
               .setCharacteristic(Characteristic.TargetDoorState, 1)
               .setCharacteristic(Characteristic.ObstructionDetected, false);
            break;
         case "sensor":
            accessory.addService(Service.ContactSensor)
               .setCharacteristic(Characteristic.ContactSensorState, 0);
            break;
         case "fan":
            accessory.addService(Service.Fanv2);
            accessory.addService(Service.Lightbulb);
            break;
         case "thermostat":
            accessory.addService(Service.Switch);
            accessory.addService(Service.TemperatureSensor);
            if (device.params.sensorType !== "DS18B20") {
               accessory.addService(Service.HumiditySensor);
            }
            break;
         case "outlet":
            accessory.addService(Service.Outlet);
            break;
         case "light":
            accessory.addService(Service.Lightbulb);
            break;
         case "switch":
            accessory.addService(Service.Switch);
            break;
         case "bridge":
            let b;
            if ((b = accessory.context.sensorType = platform.customBridgeSensors.get(hbDeviceId))) {
               accessory.context.sensorType = b.type;
            } else {
               accessory.context.sensorType = "motion";
            }
            if (!["water", "fire", "smoke", "co", "co2", "contact", "occupancy", "motion"].includes(accessory.context.sensorType)) {
               accessory.context.sensorType = "motion";
            }
            switch (accessory.context.sensorType) {
            case "water":
               accessory.addService(Service.LeakSensor);
               break;
            case "fire":
            case "smoke":
               accessory.addService(Service.SmokeSensor);
               break;
            case "co":
               accessory.addService(Service.CarbonMonoxideSensor);
               break;
            case "co2":
               accessory.addService(Service.CarbonDioxideSensor);
               break;
            case "contact":
               accessory.addService(Service.ContactSensor);
               break;
            case "occupancy":
               accessory.addService(Service.OccupancySensor);
               break;
            case "motion":
            default:
               accessory.addService(Service.MotionSensor);
               break;
            }
            break;
         default:
            throw "Device not supported by this plugin.";
         }
         platform.devicesInHB.set(hbDeviceId, accessory);
         platform.api.registerPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         platform.configureAccessory(accessory);
         platform.log("[%s] has been added to Homebridge.", newDeviceName);
      } catch (e) {
         platform.log.warn("[%s] could not be added - [%s].", accessory.displayName, e);
      }
   }
   configureAccessory(accessory) {
      if (!platform.log) {
         return;
      }
      try {
         switch (accessory.context.type) {
         case "cusBlind":
            accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
               .setProps({
                  minStep: 100
               })
               .on("set", function (value, callback) {
                  platform.internalBlindUpdate(accessory, value, callback);
               });
            break;
         case "cusGarage":
            accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.TargetDoorState)
               .on("set", function (value, callback) {
                  platform.internalGarageUpdate(accessory, value, callback);
               });
            break;
         case "fan":
            accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active)
               .on("set", function (value, callback) {
                  platform.internalFanUpdate(accessory, "power", value, callback);
               });
            accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
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
            break;
         case "thermostat":
            accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
               .on("set", function (value, callback) {
                  platform.internalThermostatUpdate(accessory, value, callback);
               });
            break;
         case "outlet":
            accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
               .on("set", function (value, callback) {
                  platform.internalOutletUpdate(accessory, value, callback);
               });
            break;
         case "light":
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
                     accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, value);
                     callback();
                  });
            }
            break;
         case "switch":
            accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
               .on("set", function (value, callback) {
                  platform.internalSwitchUpdate(accessory, value, callback);
               });
            break;
         }
         accessory.context.reachableWAN = true;
         // accessory.context.reachableLAN = true;
         platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
         platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
      } catch (e) {
         platform.log.warn("[%s] could not be refreshed - [%s].", accessory.displayName, e);
      }
   }
   externalDeviceUpdate(device) {
      let accessory;
      if (device.action === "sysmsg") {
         if ((accessory = platform.devicesInHB.get(device.deviceid + "SWX"))) {
            try {
               accessory.context.reachableWAN = device.params.online;
               platform.log("[%s] has been reported [%s].", accessory.displayName, accessory.context.reachableWAN ? "online" : "offline");
               platform.devicesInHB.set(accessory.context.hbDeviceId, accessory);
               platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
            } catch (e) {
               platform.log.warn("[%s] online/offline status could not be updated - [%s].", accessory.displayName, e);
            }
         } else if ((accessory = platform.devicesInHB.get(device.deviceid + "SW0"))) {
            let otherAccessory;
            for (let i = 0; i <= accessory.context.channelCount; i++) {
               try {
                  if (platform.devicesInHB.has(device.deviceid + "SW" + i)) {
                     otherAccessory = platform.devicesInHB.get(device.deviceid + "SW" + i);
                     otherAccessory.context.reachableWAN = device.params.online;
                     platform.log("[%s] has been reported [%s].", otherAccessory.displayName, otherAccessory.context.reachableWAN ? "online" : "offline");
                     platform.devicesInHB.set(otherAccessory.context.hbDeviceId, otherAccessory);
                     platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [otherAccessory]);
                  }
               } catch (e) {
                  platform.log.warn("[%s] new status could not be updated - [%s].", otherAccessory.displayName, e);
               }
            }
         }
      } else if (device.action === "update" && device.hasOwnProperty("params")) {
         if (platform.devicesInHB.has(device.deviceid + "SWX") || platform.devicesInHB.has(device.deviceid + "SW0")) {
            accessory = platform.devicesInHB.get(device.deviceid + "SWX") || platform.devicesInHB.get(device.deviceid + "SW0");
            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
            if (!accessory.context.reachableWAN) {
               platform.log.warn("[%s] will not be refreshed as it has been reported offline.", accessory.displayName);
               return;
            }
            if (platform.refreshAccessory(accessory, device.params)) {
               return;
            }
            if (Object.keys(device.params).length === 0 || device.params.hasOwnProperty("power") || device.params.hasOwnProperty("rssi") || device.params.hasOwnProperty("uiActive") || device.params.hasOwnProperty("sledOnline")) {
               if (platform.debug) {
                  platform.log("[%s] has sent an update which is useless to Homebridge.", accessory.displayName);
               }
               return;
            } else {
               platform.log.error("[%s] cannot be refreshed due to missing type parameter.\nPlease remove [%s] from the Homebridge cache (including any secondary devices (SW1, SW2, etc.).", accessory.displayName, accessory.displayName);
            }
         } else if (platform.customHideDvceFromHB.includes(device.deviceid)) {
            platform.log.warn("[%s] Accessory received via web socket has been hidden from Homebridge as per use configuration.", device.deviceid);
         } else {
            platform.log.warn("[%s] Accessory received via web socket does not exist in Homebridge. If it's a new accessory please restart Homebridge so it is added.", device.deviceid);
         }
      } else if (platform.debug) {
         platform.log.warn("[%s] unknown action or parameters received via web socket.", device.name);
      }
   }
   refreshAccessory(accessory, newParams) {
      switch (accessory.context.type) {
      case "cusBlind":
         if (Array.isArray(newParams.switches)) {
            platform.externalBlindUpdate(accessory, newParams);
            return true;
         }
         break;
      case "cusGarage":
         if (newParams.hasOwnProperty("switch")) {
            platform.externalGarageUpdate(accessory, newParams);
            return true;
         }
         break;
      case "sensor":
         if (newParams.hasOwnProperty("switch")) {
            platform.externalSensorUpdate(accessory, newParams);
            return true;
         }
         break;
      case "fan":
         if (Array.isArray(newParams.switches)) {
            platform.externalFanUpdate(accessory, newParams);
            return true;
         }
         break;
      case "thermostat":
         if (newParams.hasOwnProperty("currentTemperature") || newParams.hasOwnProperty("currentHumidity") || newParams.hasOwnProperty("switch") || newParams.hasOwnProperty("masterSwitch")) {
            platform.externalThermostatUpdate(accessory, newParams);
            return true;
         }
         break;
      case "outlet":
         if (newParams.hasOwnProperty("switch")) {
            platform.externalOutletUpdate(accessory, newParams);
            return true;
         }
         break;
      case "light":
         if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID) && constants.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
            if (newParams.hasOwnProperty("switch") || newParams.hasOwnProperty("state") || newParams.hasOwnProperty("bright") || newParams.hasOwnProperty("colorR") || newParams.hasOwnProperty("brightness") || newParams.hasOwnProperty("channel0") || newParams.hasOwnProperty("channel2") || newParams.hasOwnProperty("zyx_mode")) {
               platform.externalSingleLightUpdate(accessory, newParams);
               return true;
            }
         } else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID) && constants.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
            if (Array.isArray(newParams.switches)) {
               platform.externalMultiLightUpdate(accessory, newParams);
               return true;
            }
         }
         break;
      case "switch":
         if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
            if (newParams.hasOwnProperty("switch")) {
               platform.externalSingleSwitchUpdate(accessory, newParams);
               return true;
            }
         } else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
            if (Array.isArray(newParams.switches)) {
               platform.externalMultiSwitchUpdate(accessory, newParams);
               return true;
            }
         }
         break;
      case "bridge":
         platform.externalBridgeUpdate(accessory, newParams);
         return true;
      default:
         return false;
      }
   }
   removeAccessory(accessory) {
      try {
         platform.devicesInHB.delete(accessory.context.hbDeviceId);
         platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         platform.log("[%s] will be removed from Homebridge.", accessory.displayName);
      } catch (e) {
         platform.log.warn("[%s] needed to be removed but couldn't - [%s].", accessory.displayName, e);
      }
   }
   removeAllAccessories() {
      try {
         platform.warn("[0] primary devices were loaded from your eWeLink account so any eWeLink devices in the Homebridge cache will be removed. This plugin will no longer load as there is no reason to continue.");
         platform.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", Array.from(platform.devicesInHB.values()));
         platform.devicesInHB.clear();
      } catch (e) {
         platform.log.warn("Accessories could not be removed from the Homebridge cache - [%s].", e);
      }
   }
   internalBlindUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let blindConfig;
         if (!(blindConfig = platform.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (blindConfig.type !== "cusBlind" || !["oneSwitch", "twoSwitch"].includes(blindConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = blindConfig.sensorFullId || false;
         let sensorAccessory = false;
         if (sensorDefinition && !(sensorAccessory = platform.devicesInHB.get(blindConfig.sensorFullId))) {
            throw "defined sensor doesn't exist";
         }
         let cPos;
         if (sensorAccessory) {
            cPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value * 100;
         } else {
            cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
         }
         if (cPos === value) {
            platform.log("[%s] is already [%s]. Nothing to do.", accessory.displayName, value === 0 ? "closed" : "open");
            //   0 = blind closed
            // 100 = blind open
            callback();
            return;
         }
         value = value >= 50 ? 100 : 0;
         let service = accessory.getService(Service.WindowCovering);
         //let payload;
         //if (blindConfig.setup === "twoSwitch") {
         //payload = {
         //apikey: accessory.context.eweApiKey,
         //deviceid: accessory.context.eweDeviceId,
         //params: {
         //switches: platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches
         //}
         //};
         //payload.params.switches[0].switch = value === 100 ? "on" : "off";
         //payload.params.switches[1].switch = value === 0 ? "on" : "off";
         //} else {
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switch: "on"
            }
         };
         //}
         platform.log("[%s] updating target position to [%s%].", accessory.displayName, value);
         platform.wsClient.sendUpdate(payload, function () {
            return;
         });
         service
            .updateCharacteristic(Characteristic.TargetPosition, value)
            .updateCharacteristic(Characteristic.PositionState, (value / 100));
         if (!blindConfig.inched || blindConfig.inched === "false") {
            setTimeout(function () {
               //if (blindConfig.setup === "twoSwitch") {
               //payload.params.switches[0].switch = "off";
               //payload.params.switches[1].switch = "off";
               //} else {
               payload.params.switch = "off";
               //}
               platform.wsClient.sendUpdate(payload, function () {
                  return;
               });
            }, 500);
         } else {
            if (platform.debug) {
               platform.log("[%s] not sending off command as inched through eWeLink.", accessory.displayName);
            }
         }
         setTimeout(() => {
            service
               .updateCharacteristic(Characteristic.CurrentPosition, value)
               .updateCharacteristic(Characteristic.PositionState, 2);
            callback();
         }, blindConfig.operationTime * 100);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalGarageUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let garageConfig;
         if (!(garageConfig = platform.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (garageConfig.type !== "cusGarage" || !["oneSwitch", "twoSwitch"].includes(garageConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = garageConfig.sensorFullId || false;
         let sensorAccessory = false;
         if (sensorDefinition && !(sensorAccessory = platform.devicesInHB.get(garageConfig.sensorFullId))) {
            throw "defined sensor doesn't exist";
         }
         let cPos;
         if (sensorAccessory) {
            cPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value === 0 ?
               1 // 1 = contact not detected  -> garage open
               :
               0; // 0 = contact detected      -> garage closed
         } else {
            cPos = accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.CurrentDoorState).value;
            // 0 = garage open
            // 1 = garage closed
         }
         if (cPos === value) {
            platform.log("[%s] is already [%s]. Nothing to do.", accessory.displayName, value === 0 ? "closed" : "open");
            callback();
            return;
         }
         let service = accessory.getService(Service.GarageDoorOpener);
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switch: "on"
            }
         };
         platform.log("[%s] updating garage door to [%s].", accessory.displayName, value === 0 ? "opening" : "closing");
         platform.wsClient.sendUpdate(payload, function () {
            return;
         });
         service
            .updateCharacteristic(Characteristic.TargetDoorState, value === 0 ? 0 : 1)
            .updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 2 : 3);
         if (!garageConfig.inched || garageConfig.inched === "false") {
            setTimeout(function () {
               payload.params.switch = "off";
               platform.wsClient.sendUpdate(payload, function () {
                  return;
               });
            }, 500);
         } else {
            if (platform.debug) {
               platform.log("[%s] not sending off command as inched through eWeLink.", accessory.displayName);
            }
         }
         setTimeout(function () {
            service.updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 0 : 1);
            callback();
         }, parseInt(garageConfig.operationTime) * 100);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalFanUpdate(accessory, type, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let newPower, newSpeed, newLight;
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
            newPower = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active).value;
            newSpeed = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value;
            newLight = value;
            break;
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switches: platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches,
            }
         };
         payload.params.switches[0].switch = newLight ? "on" : "off";
         payload.params.switches[1].switch = newSpeed >= 33 ? "on" : "off";
         payload.params.switches[2].switch = newSpeed >= 66 && newSpeed < 99 ? "on" : "off";
         payload.params.switches[3].switch = newSpeed >= 99 ? "on" : "off";
         if (platform.debug) {
            platform.log("[%s] updating [%s] to [%s].", accessory.displayName, type, value);
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newLight);
         accessory.getService(Service.Fanv2)
            .updateCharacteristic(Characteristic.Active, newPower)
            .updateCharacteristic(Characteristic.RotationSpeed, newSpeed);
         platform.wsClient.sendUpdate(payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalThermostatUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switch: value ? "on" : "off",
               mainSwitch: value ? "on" : "off"
            }
         };
         if (platform.debug) {
            platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         platform.wsClient.sendUpdate(payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalOutletUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switch: value ? "on" : "off"
            }
         };
         if (platform.debug) {
            platform.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         }
         accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, value);
         platform.wsClient.sendUpdate(payload, callback);
      } catch (err) {
         callback("[" + accessory.displayName + "] " + err + ".");
      }
   }
   internalLightbulbUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let otherAccessory;
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
            if (platform.debug) {
               platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            break;
         case "0":
            payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            payload.params.switches[0].switch = value ? "on" : "off";
            payload.params.switches[1].switch = value ? "on" : "off";
            payload.params.switches[2].switch = value ? "on" : "off";
            payload.params.switches[3].switch = value ? "on" : "off";
            if (platform.debug) {
               platform.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            for (let i = 1; i <= 4; i++) {
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
            if (platform.debug) {
               platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            let tAccessory;
            let masterState = "off";
            payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            for (let i = 1; i <= 4; i++) {
               if ((tAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i))) {
                  if (i === parseInt(accessory.context.switchNumber)) {
                     payload.params.switches[i - 1].switch = value ? "on" : "off";
                  } else {
                     payload.params.switches[i - 1].switch = tAccessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value ? "on" : "off";
                  }
                  if (tAccessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                     masterState = "on";
                  }
               } else {
                  payload.params.switches[i - 1].switch = "off";
               }
            }
            otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
            otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState === "on");
            break;
         default:
            throw "unknown switch number [" + accessory.context.switchNumber + "]";
         }
         platform.wsClient.sendUpdate(payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalBrightnessUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
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
            switch (accessory.context.eweUIID) {
            case 36: // KING-M4
               payload.params.bright = Math.round(value * 9 / 10 + 10);
               break;
            case 44: // D1
               payload.params.brightness = value;
               payload.params.mode = 0;
               break;
            default:
               throw "unknown device UIID";
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
         }
         if (platform.debug) {
            platform.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
         }
         setTimeout(function () {
            platform.wsClient.sendUpdate(payload, callback);
         }, 250);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalHSBUpdate(accessory, type, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let newRGB, params;
         let curHue = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value;
         let curSat = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation).value;
         switch (type) {
         case "hue":
            newRGB = convert.hsv.rgb(value, curSat, 100);
            switch (accessory.context.eweUIID) {
            case 22: // B1
               params = {
                  zyx_mode: 2,
                  type: "middle",
                  channel0: "0",
                  channel1: "0",
                  channel2: newRGB[0].toString(),
                  channel3: newRGB[1].toString(),
                  channel4: newRGB[2].toString()
               };
               break;
            case 59: // L1
               params = {
                  mode: 1,
                  colorR: newRGB[0],
                  colorG: newRGB[1],
                  colorB: newRGB[2]
               };
               break;
            default:
               throw "unknown device UIID";
            }
            if (platform.debug) {
               platform.log("[%s] updating hue to [%s°].", accessory.displayName, value);
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Hue, value);
            break;
         case "bri":
            switch (accessory.context.eweUIID) {
            case 22: // B1
               newRGB = convert.hsv.rgb(curHue, curSat, value);
               params = {
                  zyx_mode: 2,
                  type: "middle",
                  channel0: "0",
                  channel1: "0",
                  channel2: newRGB[0].toString(),
                  channel3: newRGB[1].toString(),
                  channel4: newRGB[2].toString()
               };
               break;
            case 59: // L1
               params = {
                  mode: 1,
                  bright: value
               };
               break;
            }
            if (platform.debug) {
               platform.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, value);
            break;
         default:
            throw "unknown device UIID";
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params
         };
         setTimeout(function () {
            platform.wsClient.sendUpdate(payload, callback);
         }, 250);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   internalSwitchUpdate(accessory, value, callback) {
      try {
         // if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         if (!accessory.context.reachableWAN) {
            throw "it is currently offline";
         }
         let otherAccessory;
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {}
         };
         switch (accessory.context.switchNumber) {
         case "X":
            payload.params.switch = value ? "on" : "off";
            if (platform.debug) {
               platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            break;
         case "0":
            payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            payload.params.switches[0].switch = value ? "on" : "off";
            payload.params.switches[1].switch = value ? "on" : "off";
            payload.params.switches[2].switch = value ? "on" : "off";
            payload.params.switches[3].switch = value ? "on" : "off";
            if (platform.debug) {
               platform.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            for (let i = 1; i <= 4; i++) {
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
            if (platform.debug) {
               platform.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            let tAccessory;
            let masterState = "off";
            payload.params.switches = platform.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            for (let i = 1; i <= 4; i++) {
               if ((tAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i))) {
                  if (i === parseInt(accessory.context.switchNumber)) {
                     payload.params.switches[i - 1].switch = value ? "on" : "off";
                  } else {
                     payload.params.switches[i - 1].switch = tAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value ? "on" : "off";
                  }
                  if (tAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value) {
                     masterState = "on";
                  }
               } else {
                  payload.params.switches[i - 1].switch = "off";
               }
            }
            otherAccessory = platform.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
            otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState === "on");
            break;
         default:
            throw "unknown switch number [" + accessory.context.switchNumber + "]";
         }
         platform.wsClient.sendUpdate(payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] " + err + ".";
         platform.log.error(str);
         callback(str);
      }
   }
   externalBlindUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         let blindConfig;
         if (!(blindConfig = platform.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (blindConfig.type !== "cusBlind" || !["oneSwitch", "twoSwitch"].includes(blindConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = blindConfig.sensorFullId || false;
         let sensorAccessory = false;
         if (sensorDefinition && !(sensorAccessory = platform.devicesInHB.get(blindConfig.sensorFullId))) {
            throw "defined sensor doesn't exist";
         }
         let cPos;
         if (sensorAccessory) {
            cPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value * 100;
         } else {
            cPos = accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.CurrentPosition).value;
         }
         // checks over. phew.
         let curPos;
         if (blindConfig.setup === "twoSwitch") {
            if (sensorAccessory) {
               cPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value;
            } else {
               let switchUp = params.switches[0].switch === "on" ? -1 : 0; // matrix of numbers to get
               let switchDown = params.switches[1].switch === "on" ? 0 : 2; // ... the correct HomeKit value
               curPos = switchUp + switchDown;
            }
         } else { // must be oneSwitch!
            curPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value;
         }
         let newPosition = curPos * 100; // ie newPosition is 0x0=0% if moving down or 1x100=100% if moving up
         if ((curPos !== 0 && curPos !== 1) || (newPosition === accessory.context.cachePosition)) {
            return; // as requested position is equal to current position
         }
         accessory.getService(Service.WindowCovering)
            .updateCharacteristic(Characteristic.PositionState, curPos)
            .updateCharacteristic(Characteristic.TargetPosition, newPosition);
         setTimeout(() => {
            accessory.getService(Service.WindowCovering)
               .updateCharacteristic(Characteristic.PositionState, 2)
               .updateCharacteristic(Characteristic.CurrentPosition, newPosition);
         }, blindConfig.operationTime * 100);
         try {
            accessory.context.cachePosition = newPosition;
            platform.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         } catch (e) {
            platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, e);
         }
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalGarageUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         if (params.switch !== "on") {
            return;
         }
         let garageConfig;
         if (!(garageConfig = platform.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (garageConfig.type !== "cusGarage" || !["oneSwitch", "twoSwitch"].includes(garageConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = garageConfig.sensorFullId || false;
         let sensorAccessory = false;
         if (sensorDefinition && !(sensorAccessory = platform.devicesInHB.get(garageConfig.sensorFullId))) {
            throw "defined sensor doesn't exist";
         }
         let cPos;
         if (sensorAccessory) {
            cPos = sensorAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value === 0 ?
               1 // 1 = contact not detected  -> garage open
               :
               0; // 0 = contact detected      -> garage closed
         } else {
            cPos = accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.CurrentDoorState).value;
            // 0 = garage open
            // 1 = garage closed
         }
         accessory.getService(Service.GarageDoorOpener)
            .updateCharacteristic(Characteristic.TargetDoorState, cPos === 0 ? 1 : 0)
            .updateCharacteristic(Characteristic.CurrentDoorState, cPos === 0 ? 1 : 0);
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSensorUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         accessory.getService(Service.ContactSensor).updateCharacteristic(Characteristic.ContactSensorState, params.switch === "on" ? 1 : 0);
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalFanUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[0].switch === "on");
         let status = 0;
         let speed = 0;
         if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "off") {
            status = 1;
            speed = 33;
         } else if (params.switches[1].switch === "on" && params.switches[2].switch === "on" && params.switches[3].switch === "off") {
            status = 1;
            speed = 66;
         } else if (params.switches[1].switch === "on" && params.switches[2].switch === "off" && params.switches[3].switch === "on") {
            status = 1;
            speed = 100;
         }
         accessory.getService(Service.Fanv2)
            .updateCharacteristic(Characteristic.Active, status)
            .updateCharacteristic(Characteristic.RotationSpeed, speed);
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalThermostatUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
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
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalOutletUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, params.switch === "on");
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSingleLightUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         let newColour, mode;
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
                  let nb = Math.round((params.bright - 10) * 10 / 9); // eWeLink scale is 10-100 and HomeKit scale is 0-100.
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, nb);
               }
               break;
            case 44: // D1
               if (params.hasOwnProperty("brightness")) {
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.brightness);
               }
               break;
            case 22: // B1
               if (params.hasOwnProperty("zyx_mode")) {
                  mode = parseInt(params.zyx_mode);
               } else if (params.hasOwnProperty("channel0") && (parseInt(params.channel0) + parseInt(params.channel1) > 0)) {
                  mode = 1;
               } else {
                  mode = 2;
               }
               if (mode === 2) {
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, true);
                  newColour = convert.rgb.hsv(parseInt(params.channel2), parseInt(params.channel3), parseInt(params.channel4));
                  // The eWeLink app only supports hue change in app so set saturation and brightness to 100.
                  accessory.getService(Service.Lightbulb)
                     .updateCharacteristic(Characteristic.Hue, newColour[0])
                     .updateCharacteristic(Characteristic.Saturation, 100)
                     .updateCharacteristic(Characteristic.Brightness, 100);
               } else if (mode === 1) {
                  throw "has been set to white mode which is not supported";
               }
               break;
            case 59: // L1
               if (params.hasOwnProperty("bright")) {
                  accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, params.bright);
               }
               if (params.hasOwnProperty("colorR")) {
                  newColour = convert.rgb.hsv(params.colorR, params.colorG, params.colorB);
                  accessory.getService(Service.Lightbulb)
                     .updateCharacteristic(Characteristic.Hue, newColour[0])
                     .updateCharacteristic(Characteristic.Saturation, newColour[1]);
               }
               break;
            default:
               return;
            }
         } else {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, false);
         }
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalMultiLightUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let primaryState = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (platform.devicesInHB.has(idToCheck + i)) {
               let otherAccessory = platform.devicesInHB.get(idToCheck + i);
               otherAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
               if (params.switches[i - 1].switch === "on") {
                  primaryState = true;
               }
            }
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSingleSwitchUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switch === "on");
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalMultiSwitchUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let primaryState = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (platform.devicesInHB.has(idToCheck + i)) {
               let otherAccessory = platform.devicesInHB.get(idToCheck + i);
               otherAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
               if (params.switches[i - 1].switch === "on") {
                  primaryState = true;
               }
            }
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalBridgeUpdate(accessory, params) {
      try {
         if (platform.debug) {
            platform.log("[%s] will be refreshed.", accessory.displayName);
         }
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let timeNow = new Date();
         let master = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (platform.devicesInHB.has(idToCheck + i)) {
               let otherAccessory = platform.devicesInHB.get(idToCheck + i);
               if (params.hasOwnProperty("rfTrig" + (i - 1))) {
                  let timeOfMotion = new Date(params["rfTrig" + (i - 1)]);
                  let timeDifference = (timeNow.getTime() - timeOfMotion.getTime()) / 1000;
                  if (timeDifference < platform.sensorTimeDifference) {
                     switch (otherAccessory.context.sensorType) {
                     case "water":
                        otherAccessory.getService(Service.LeakSensor).updateCharacteristic(Characteristic.LeakDetected, 1);
                        break;
                     case "fire":
                     case "smoke":
                        otherAccessory.getService(Service.SmokeSensor).updateCharacteristic(Characteristic.SmokeDetected, 1);
                        break;
                     case "co":
                        otherAccessory.getService(Service.CarbonMonoxideSensor).updateCharacteristic(Characteristic.CarbonMonoxideDetected, 1);
                        break;
                     case "co2":
                        otherAccessory.getService(Service.CarbonDioxideSensor).updateCharacteristic(Characteristic.CarbonDioxideDetected, 1);
                        break;
                     case "contact":
                        otherAccessory.getService(Service.ContactSensor).updateCharacteristic(Characteristic.ContactSensorState, 1);
                        break;
                     case "occupancy":
                        otherAccessory.getService(Service.OccupancySensor).updateCharacteristic(Characteristic.OccupancyDetected, 1);
                        break;
                     case "motion":
                     default:
                        otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
                        break;
                     }
                     master = true;
                     if (platform.debug) {
                        platform.log("[%s] has detected [%s].", otherAccessory.displayName, otherAccessory.context.sensorType);
                     }
                  }
               }
            }
         }
         if (master) {
            accessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
            setTimeout(() => {
               for (let i = 0; i <= accessory.context.channelCount; i++) {
                  if (platform.devicesInHB.has(idToCheck + i)) {
                     let otherAccessory = platform.devicesInHB.get(idToCheck + i);
                     switch (otherAccessory.context.sensorType) {
                     case "water":
                        otherAccessory.getService(Service.LeakSensor).updateCharacteristic(Characteristic.LeakDetected, 0);
                        break;
                     case "fire":
                     case "smoke":
                        otherAccessory.getService(Service.SmokeSensor).updateCharacteristic(Characteristic.SmokeDetected, 0);
                        break;
                     case "co":
                        otherAccessory.getService(Service.CarbonMonoxideSensor).updateCharacteristic(Characteristic.CarbonMonoxideDetected, 0);
                        break;
                     case "co2":
                        otherAccessory.getService(Service.CarbonDioxideSensor).updateCharacteristic(Characteristic.CarbonDioxideDetected, 0);
                        break;
                     case "contact":
                        otherAccessory.getService(Service.ContactSensor).updateCharacteristic(Characteristic.ContactSensorState, 0);
                        break;
                     case "occupancy":
                        otherAccessory.getService(Service.OccupancySensor).updateCharacteristic(Characteristic.OccupancyDetected, 0);
                        break;
                     case "motion":
                     default:
                        otherAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, false);
                        break;
                     }
                  }
               }
            }, platform.sensorTimeLength * 1000);
         }
      } catch (err) {
         platform.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalLANUpdate(device) {
      try {
         if (platform.debug) {
            platform.log("LAN mode status update detected. This feature is in early stages.");
         }
      } catch (err) {
         platform.log.warn("Generic Error Message - [%s]", err);
      }
   }
}
module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   return eWeLink;
};
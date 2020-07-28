/* jshint esversion: 9, -W030, node: true */
"use strict";
const constants = require("./constants");
const convert = require("color-convert");
const eWeLinkHTTP = require("./eWeLinkHTTP");
const eWeLinkWS = require("./eWeLinkWS");
const eWeLinkLAN = require("./eWeLinkLAN");
let Accessory, Service, Characteristic, UUIDGen;
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
      this.log = log;
      this.config = config;
      this.api = api;
      this.mode = this.config.mode || "ws";
      this.debug = this.config.debug || false;
      this.customHideChanFromHB = this.config.hideFromHB || "";
      this.customHideDvceFromHB = this.config.hideDevFromHB || "";
      this.sensorTimeLength = this.config.sensorTimeLength || 2;
      this.sensorTimeDifference = this.config.sensorTimeDifference || 120;
      this.devicesInHB = new Map();
      this.devicesInEwe = new Map();
      this.customGroups = new Map();
      this.customBridgeSensors = new Map();
      this.api.on("didFinishLaunching", () => {
         this.log("Plugin has finished initialising. Starting synchronisation with eWeLink account.");
         //*** Set up HTTP client and get the user HTTP host ***\\
         this.httpClient = new eWeLinkHTTP(this.config, this.log);
         this.httpClient.getHost()
            .then(res => { //*** Use the HTTP API host to log into eWeLink ***\\
               return this.httpClient.login();
            }).then(res => { //*** Set up the web socket client ***\\
               this.wsClient = new eWeLinkWS(this.config, this.log, res);
               return this.wsClient.getHost();
            }).then(res => { //*** Open web socket connection and get device list via HTTP ***\\
               this.wsClient.login();
               return this.httpClient.getDevices();
            }).then(res => { //*** Get device IP addresses for LAN mode ***\\
               this.httpDevices = res;
               this.lanClient = new eWeLinkLAN(this.config, this.log, this.httpDevices);
               return this.lanClient.getHosts();
            }).then(res => { //*** Set up the LAN mode listener ***\\
               this.lanDevices = res;
               return this.lanClient.startMonitor();
            }).then(res => { //*** Use the device list to refresh Homebridge accessories ***\\
               (() => {
                  //*** Remove all Homebridge accessories if none found ***\\
                  if (Object.keys(this.httpDevices).length === 0 && Object.keys(this.lanDevices).length === 0) {
                     this.removeAllAccessories();
                     return;
                  }
                  //*** Make a map of compatible devices from eWeLink ***\\
                  this.httpDevices.forEach(device => {
                     if (device.type !== "10" || this.customHideDvceFromHB.includes(device.deviceid)) {
                        return;
                     }
                     this.devicesInEwe.set(device.deviceid, device);
                  });
                  //*** Make a map of custom groups from Homebridge config ***\\
                  if (this.config.groups && Object.keys(this.config.groups).length > 0) {
                     this.config.groups.forEach(group => {
                        if (typeof group.deviceId !== "undefined" && this.devicesInEwe.has(group.deviceId.toLowerCase())) {
                           this.customGroups.set(group.deviceId + "SWX", group);
                        }
                     });
                  }
                  //*** Make a map of RF Bridge custom sensors from Homebridge config ***\\
                  if (this.config.bridgeSensors && Object.keys(this.config.bridgeSensors).length > 0) {
                     this.config.bridgeSensors.forEach(bridgeSensor => {
                        if (typeof bridgeSensor.deviceId !== "undefined" && this.devicesInEwe.has(bridgeSensor.deviceId.toLowerCase())) {
                           this.customBridgeSensors.set(bridgeSensor.fullDeviceId, bridgeSensor);
                        }
                     });
                  }
                  //*** Logging always helps to see if everything is okay so far ***\\
                  this.log("[%s] eWeLink devices were loaded from the Homebridge cache.", this.devicesInHB.size);
                  this.log("[%s] primary devices were loaded from your eWeLink account.", this.devicesInEwe.size);
                  this.log("[%s] primary devices were discovered on your local network.", Object.keys(this.lanDevices).length);
                  this.log("[%s] custom groups were loaded from the configuration.", this.customGroups.size);
                  //*** Remove Homebridge accessories that don't appear in eWeLink ***\\
                  if (this.devicesInHB.size > 0) {
                     this.devicesInHB.forEach(accessory => {
                        if (!this.devicesInEwe.has(accessory.context.eweDeviceId)) {
                           this.removeAccessory(accessory);
                        }
                     });
                  }
                  //*** Disable plugin if no eWeLink devices ***\\
                  if (this.devicesInEwe.size === 0) {
                     return;
                  }
                  //*** Synchronise (add/refresh) devices between eWeLink and Homebridge ***\\
                  this.devicesInEwe.forEach(device => {
                     this.initialiseDevice(device);
                  });
                  //*** Set up the ws listener for future external device updates ***\\
                  this.wsClient.receiveUpdate(device => {
                     this.receiveDeviceUpdate(device);
                  });
                  //*** Set up the lan listener for future external device updates ***\\
                  this.lanClient.receiveUpdate(device => {
                     this.receiveDeviceUpdate(device);
                  });
                  this.log("Synchronisation complete. Ready to go!");
               })();
            }).catch(err => {
               this.log.error("** eWeLink synchronisation error: **");
               this.log.warn(err);
               this.log.error("** Plugin will not be loaded. **");
            });
      });
   }
   initialiseDevice(device) {
      let accessory;
      //*** First add the device if it isn't already in Homebridge ***\\
      if (!this.devicesInHB.has(device.deviceid + "SWX") && !this.devicesInHB.has(device.deviceid + "SW0")) {
         if (this.customGroups.has(device.deviceid + "SWX") && this.customGroups.get(device.deviceid + "SWX").type === "blind") {
            this.addAccessory(device, device.deviceid + "SWX", "blind");
         } else if (this.customGroups.has(device.deviceid + "SWX") && this.customGroups.get(device.deviceid + "SWX").type === "garage") {
            this.addAccessory(device, device.deviceid + "SWX", "garage");
         } else if (constants.devicesSensor.includes(device.uiid)) {
            this.addAccessory(device, device.deviceid + "SWX", "sensor");
         } else if (constants.devicesFan.includes(device.uiid)) {
            this.addAccessory(device, device.deviceid + "SWX", "fan");
         } else if (constants.devicesThermostat.includes(device.uiid)) {
            this.addAccessory(device, device.deviceid + "SWX", "thermostat");
         } else if (constants.devicesOutlet.includes(device.uiid)) {
            this.addAccessory(device, device.deviceid + "SWX", "outlet");
         } else if (constants.devicesSingleSwitch.includes(device.uiid) && constants.devicesSingleSwitchLight.includes(device.productModel)) {
            this.addAccessory(device, device.deviceid + "SWX", "light");
         } else if (constants.devicesMultiSwitch.includes(device.uiid) && constants.devicesMultiSwitchLight.includes(device.productModel)) {
            for (let i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
               this.addAccessory(device, device.deviceid + "SW" + i, "light");
            }
         } else if (constants.devicesSingleSwitch.includes(device.uiid)) {
            this.addAccessory(device, device.deviceid + "SWX", "switch");
         } else if (constants.devicesMultiSwitch.includes(device.uiid)) {
            for (let i = 0; i <= constants.chansFromUiid[device.uiid]; i++) {
               this.addAccessory(device, device.deviceid + "SW" + i, "switch");
            }
         } else if (constants.devicesBridge.includes(device.uiid)) {
            for (let i = 0; i <= Object.keys(device.params.rfList).length; i++) {
               this.addAccessory(device, device.deviceid + "SW" + i, "bridge");
            }
         } else {
            this.log.warn("[%s] could not be added as it is not supported by this plugin.", device.name);
         }
      }
      //*** Next refresh the device ***\\
      if ((accessory = this.devicesInHB.get(device.deviceid + "SWX"))) {
         accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
         accessory.context.reachableWAN = device.online;
         accessory.context.reachableLAN = this.lanDevices[device.deviceid].ip || false;
         if (accessory.context.eweUIID === 102) {
            accessory.context.reachableWAN = true; //DW2 offline sometimes (as battery powered?)
         }
         let str = accessory.context.reachableLAN ?
            "and locally with IP [" + accessory.context.reachableLAN + "]" :
            (accessory.context.reachableWAN) ?
            "but LAN mode unavailable as unsupported" :
            "but LAN mode unavailable as device offline";
         this.log("[%s] found in eWeLink %s.", accessory.displayName, str);
         try {
            this.devicesInHB.set(accessory.context.hbDeviceId, accessory);
            this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         } catch (e) {
            this.log.warn("[%s] online/offline status could not be updated - [%s].", accessory.displayName, e);
         }
      } else if ((accessory = this.devicesInHB.get(device.deviceid + "SW0"))) {
         accessory.context.reachableLAN = this.lanDevices[device.deviceid].ip || false;
         let str = accessory.context.reachableLAN ?
            "and locally with IP [" + accessory.context.reachableLAN + "]" :
            (accessory.context.reachableWAN) ?
            "but LAN mode unavailable as unsupported" :
            "but LAN mode unavailable as device offline";
         this.log("[%s] found in eWeLink %s.", accessory.displayName, str);
         for (let i = 0; i <= accessory.context.channelCount; i++) {
            let oAccessory;
            try {
               if (!this.devicesInHB.has(device.deviceid + "SW" + i)) {
                  if (i > 0 && this.customHideChanFromHB.includes(device.deviceid + "SW" + i) && accessory.context.type === "switch") {
                     continue;
                  } else {
                     this.addAccessory(device, device.deviceid + "SW" + i, "switch");
                  }
               }
               oAccessory = this.devicesInHB.get(device.deviceid + "SW" + i);
               if (i > 0 && this.customHideChanFromHB.includes(device.deviceid + "SW" + i) && accessory.context.type === "switch") {
                  this.removeAccessory(oAccessory);
                  continue;
               }
               oAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
               oAccessory.context.reachableWAN = device.online;
               oAccessory.context.reachableLAN = this.lanDevices[device.deviceid].ip || false;
               this.devicesInHB.set(oAccessory.context.hbDeviceId, oAccessory);
               this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [oAccessory]);
            } catch (e) {}
         }
      } else {
         this.log.warn("[%s] will not be refreshed as it wasn't found in Homebridge.", device.name);
         return;
      }
      if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
         this.log.warn("[%s] will not be refreshed as it has been reported offline.", accessory.displayName);
         return;
      }
      if (!this.refreshAccessory(accessory, device.params)) {
         this.log.error("[%s] could not be refreshed due to missing type parameter. Please remove accessory from the Homebridge cache along with any secondary devices (SW1, SW2, etc.). Debugging: [%s:%s:%s]", accessory.displayName, "initialise", accessory.context.type, accessory.context.channelCount);
      }
   }
   addAccessory(device, hbDeviceId, service) {
      let channelCount = service === "bridge" ? Object.keys(device.params.rfList).length : constants.chansFromUiid[device.uiid];
      let switchNumber = hbDeviceId.substr(-1).toString();
      let newDeviceName = device.name;
      if (["1", "2", "3", "4"].includes(switchNumber)) {
         newDeviceName += " SW" + switchNumber;
         if (this.customHideChanFromHB.includes(hbDeviceId) && service === "switch") {
            this.log.warn("[%s] has not been added as per configuration", newDeviceName);
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
         accessory.context = {
            hbDeviceId,
            eweDeviceId: device.deviceid,
            eweUIID: device.uiid,
            eweModel: device.productModel,
            eweApiKey: device.apikey,
            switchNumber,
            channelCount,
            type: service
         };
         switch (service) {
         case "blind":
            accessory.addService(Service.WindowCovering)
               .setCharacteristic(Characteristic.CurrentPosition, 100)
               .setCharacteristic(Characteristic.TargetPosition, 100)
               .setCharacteristic(Characteristic.PositionState, 2);
            break;
         case "garage":
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
            accessory.context.sensorType = this.customBridgeSensors.has(hbDeviceId) ?
               this.customBridgeSensors.get(hbDeviceId).type : "motion";
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
         this.devicesInHB.set(hbDeviceId, accessory);
         this.api.registerPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         this.configureAccessory(accessory);
         this.log("[%s] has been added to Homebridge.", newDeviceName);
      } catch (e) {
         this.log.warn("[%s] could not be added - [%s].", accessory.displayName, e);
      }
   }
   configureAccessory(accessory) {
      if (!this.log) {
         return;
      }
      try {
         switch (accessory.context.type) {
         case "blind":
            accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition)
               .setProps({
                  minStep: 100 //*** Mimics an open/closed switch. Best I can do for now. ***\\
               })
               .on("set", (value, callback) => {
                  accessory.getService(Service.WindowCovering).getCharacteristic(Characteristic.TargetPosition).value !== value ?
                     this.internalBlindUpdate(accessory, value, callback) :
                     callback();
               });
            break;
         case "garage":
            accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.TargetDoorState)
               .on("set", (value, callback) => {
                  accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.TargetDoorState).value !== value ?
                     this.internalGarageUpdate(accessory, value, callback) :
                     callback();
               });
            break;
         case "fan":
            accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active).value !== value ?
                     this.internalFanUpdate(accessory, "power", value, callback) :
                     callback();
               });
            accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
               .setProps({
                  minStep: 33
               })
               .on("set", (value, callback) => {
                  if (value > 0) {
                     if (accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active).value === 0) {
                        this.internalFanUpdate(accessory, "power", true, callback);
                     }
                     accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value !== value ?
                        this.internalFanUpdate(accessory, "speed", value, callback) :
                        callback();
                  } else {
                     accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active).value === 1 ?
                        this.internalLightbulbUpdate(accessory, "power", false, callback) :
                        callback();
                  }
               });
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value ?
                     this.internalFanUpdate(accessory, "light", value, callback) :
                     callback();
               });
            break;
         case "thermostat":
            accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value !== value ?
                     this.internalThermostatUpdate(accessory, value, callback) :
                     callback();
               });
            break;
         case "outlet":
            accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Outlet).getCharacteristic(Characteristic.On).value !== value ?
                     this.internalOutletUpdate(accessory, value, callback) :
                     callback();
               });
            break;
         case "light":
            accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value !== value ?
                     this.internalLightbulbUpdate(accessory, value, callback) :
                     callback();
               });
            if (constants.devicesBrightable.includes(accessory.context.eweUIID)) {
               accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
                  .on("set", (value, callback) => {
                     if (value > 0) {
                        if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                           this.internalLightbulbUpdate(accessory, true, callback);
                        }
                        accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value ?
                           this.internalBrightnessUpdate(accessory, value, callback) :
                           callback();
                     } else {
                        accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value ?
                           this.internalLightbulbUpdate(accessory, false, callback) :
                           callback();
                     }
                  });
            } else if (constants.devicesColourable.includes(accessory.context.eweUIID)) {
               accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
                  .on("set", (value, callback) => {
                     if (value > 0) {
                        if (!accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                           this.internalLightbulbUpdate(accessory, true, callback);
                        }
                        accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).value !== value ?
                           this.internalHSBUpdate(accessory, "bri", value, callback) :
                           callback();
                     } else {
                        accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value ?
                           this.internalLightbulbUpdate(accessory, false, callback) :
                           callback();
                     }
                  });
               accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue)
                  .on("set", (value, callback) => {
                     accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Hue).value !== value ?
                        this.internalHSBUpdate(accessory, "hue", value, callback) :
                        callback();
                  });
               accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Saturation)
                  .on("set", (value, callback) => {
                     accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Saturation, value);
                     callback();
                  });
            }
            break;
         case "switch":
            accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
               .on("set", (value, callback) => {
                  accessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value !== value ?
                     this.internalSwitchUpdate(accessory, value, callback) :
                     callback();
               });
            break;
         }
         accessory.context.reachableWAN = true;
         accessory.context.reachableLAN = true;
         this.devicesInHB.set(accessory.context.hbDeviceId, accessory);
         this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
      } catch (e) {
         this.log.warn("[%s] could not be refreshed - [%s].", accessory.displayName, e);
      }
   }
   refreshAccessory(accessory, newParams) {
      switch (accessory.context.type) {
      case "blind":
         if (Array.isArray(newParams.switches)) {
            this.externalBlindUpdate(accessory, newParams);
            return true;
         }
         break;
      case "garage":
         if (newParams.hasOwnProperty("switch") || Array.isArray(newParams.switches)) {
            this.externalGarageUpdate(accessory, newParams);
            return true;
         }
         break;
      case "sensor":
         if (newParams.hasOwnProperty("switch")) {
            this.externalSensorUpdate(accessory, newParams);
            return true;
         }
         break;
      case "fan":
         if (Array.isArray(newParams.switches) || (newParams.hasOwnProperty("light") && newParams.hasOwnProperty("fan") && newParams.hasOwnProperty("speed"))) {
            this.externalFanUpdate(accessory, newParams);
            return true;
         }
         break;
      case "thermostat":
         if (newParams.hasOwnProperty("currentTemperature") || newParams.hasOwnProperty("currentHumidity") || newParams.hasOwnProperty("switch") || newParams.hasOwnProperty("masterSwitch")) {
            this.externalThermostatUpdate(accessory, newParams);
            return true;
         }
         break;
      case "outlet":
         if (newParams.hasOwnProperty("switch")) {
            this.externalOutletUpdate(accessory, newParams);
            return true;
         }
         break;
      case "light":
         if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID) && constants.devicesSingleSwitchLight.includes(accessory.context.eweModel)) {
            if (newParams.hasOwnProperty("switch") || newParams.hasOwnProperty("state") || newParams.hasOwnProperty("bright") || newParams.hasOwnProperty("colorR") || newParams.hasOwnProperty("brightness") || newParams.hasOwnProperty("channel0") || newParams.hasOwnProperty("channel2") || newParams.hasOwnProperty("zyx_mode")) {
               this.externalSingleLightUpdate(accessory, newParams);
               return true;
            }
         } else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID) && constants.devicesMultiSwitchLight.includes(accessory.context.eweModel)) {
            if (Array.isArray(newParams.switches)) {
               this.externalMultiLightUpdate(accessory, newParams);
               return true;
            }
         }
         break;
      case "switch":
         if (constants.devicesSingleSwitch.includes(accessory.context.eweUIID)) {
            if (newParams.hasOwnProperty("switch")) {
               this.externalSingleSwitchUpdate(accessory, newParams);
               return true;
            }
         } else if (constants.devicesMultiSwitch.includes(accessory.context.eweUIID)) {
            if (Array.isArray(newParams.switches)) {
               this.externalMultiSwitchUpdate(accessory, newParams);
               return true;
            }
         }
         break;
      case "bridge":
         this.externalBridgeUpdate(accessory, newParams);
         return true;
      default:
         return false;
      }
   }
   removeAccessory(accessory) {
      try {
         this.devicesInHB.delete(accessory.context.hbDeviceId);
         this.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         this.log("[%s] will be removed from Homebridge.", accessory.displayName);
      } catch (e) {
         this.log.warn("[%s] needed to be removed but couldn't - [%s].", accessory.displayName, e);
      }
   }
   removeAllAccessories() {
      try {
         this.log.warn("[0] primary devices were loaded from your eWeLink account so any eWeLink devices in the Homebridge cache will be removed. This plugin will no longer load as there is no reason to continue.");
         this.api.unregisterPlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", Array.from(this.devicesInHB.values()));
         this.devicesInHB.clear();
      } catch (e) {
         this.log.warn("Accessories could not be removed from the Homebridge cache - [%s].", e);
      }
   }
   sendDeviceUpdate(accessory, payload, callback) {
      if (accessory.context.reachableLAN && this.mode === "lan") {
         // this.lanClient.sendUpdate(payload, callback); ***TODO***
         this.wsClient.sendUpdate(payload, callback);
      } else if (accessory.context.reachableWAN) {
         this.wsClient.sendUpdate(payload, callback);
      } else {
         this.log.error("[%s] has failed to update.", accessory.displayName);
      }
   }
   receiveDeviceUpdate(device) {
      let accessory;
      switch (device.action) {
      case "sysmsg":
         if ((accessory = this.devicesInHB.get(device.deviceid + "SWX"))) {
            try {
               if (accessory.context.reachableWAN !== device.params.online) {
                  accessory.context.reachableWAN = device.params.online;
                  this.log("[%s] has been reported [%s].", accessory.displayName, accessory.context.reachableWAN ? "online" : "offline");
                  this.devicesInHB.set(accessory.context.hbDeviceId, accessory);
                  this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
                  if (accessory.context.reachableWAN) {
                     this.wsClient.requestUpdate(accessory.context.eweDeviceId);
                  }
               }
            } catch (e) {
               this.log.warn("[%s] online/offline status could not be updated - [%s].", accessory.displayName, e);
            }
         } else if ((accessory = this.devicesInHB.get(device.deviceid + "SW0"))) {
            try {
               if (accessory.context.reachableWAN !== device.params.online) {
                  accessory.context.reachableWAN = device.params.online;
                  this.log("[%s] has been reported [%s].", accessory.displayName, accessory.context.reachableWAN ? "online" : "offline");
                  this.devicesInHB.set(accessory.context.hbDeviceId, accessory);
                  this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
                  if (accessory.context.reachableWAN) {
                     this.wsClient.requestUpdate(accessory.context.eweDeviceId);
                  }
               }
            } catch (e) {
               this.log.warn("[%s] online/offline status could not be updated - [%s].", accessory.displayName, e);
            }
            let oAccessory;
            for (let i = 1; i <= accessory.context.channelCount; i++) {
               try {
                  if (this.devicesInHB.has(device.deviceid + "SW" + i)) {
                     oAccessory = this.devicesInHB.get(device.deviceid + "SW" + i);
                     oAccessory.context.reachableWAN = device.params.online;
                     this.devicesInHB.set(oAccessory.context.hbDeviceId, oAccessory);
                     this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [oAccessory]);
                  }
               } catch (e) {
                  this.log.warn("[%s] new status could not be updated - [%s].", oAccessory.displayName, e);
               }
            }
         }
         break;
      case "update":
         if (this.devicesInHB.has(device.deviceid + "SWX") || this.devicesInHB.has(device.deviceid + "SW0")) {
            accessory = this.devicesInHB.get(device.deviceid + "SWX") || this.devicesInHB.get(device.deviceid + "SW0");
            if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
               this.log.warn("[%s] will not be refreshed as it has been reported offline.", accessory.displayName);
               return;
            }
            if (this.debug) {
               this.log("[%s] externally updated from above WS/LAN message and will be refreshed.", accessory.displayName);
            }
            if (this.refreshAccessory(accessory, device.params)) {
               return;
            }
            this.log.error("[%s] cannot be refreshed due to missing type parameter. Please remove accessory from the Homebridge cache along with any secondary devices (SW1, SW2, etc.). Debugging: [%s:%s:%s]", accessory.displayName, "refresh", accessory.context.type, accessory.context.channelCount);
         } else if (this.customHideDvceFromHB.includes(device.deviceid)) {
            this.log.warn("[%s] WS/LAN update is for hidden accessory.", device.deviceid);
         } else {
            this.log.warn("[%s] Accessory received via WS/LAN update does not exist in Homebridge. If it's a new accessory please restart Homebridge so it is added.", device.deviceid);
         }
         break;
      }
   }
   internalBlindUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let blindConfig;
         if (!(blindConfig = this.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (blindConfig.type !== "blind" || blindConfig.setup !== "twoSwitch") {
            throw "improper configuration";
         }
         value = value >= 50 ? 100 : 0;
         let service = accessory.getService(Service.WindowCovering);
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {}
         };
         payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
         payload.params.switches[0].switch = value === 100 ? "on" : "off";
         payload.params.switches[1].switch = value === 0 ? "on" : "off";
         this.log("[%s] updating target position to [%s%].", accessory.displayName, value);
         this.sendDeviceUpdate(accessory, payload, function () {
            return;
         });
         service
            .updateCharacteristic(Characteristic.TargetPosition, value)
            .updateCharacteristic(Characteristic.PositionState, (value / 100));
         if (!blindConfig.inched || blindConfig.inched === "false") {
            setTimeout(() => {
               payload.params.switches[0].switch = "off";
               payload.params.switches[1].switch = "off";
               this.sendDeviceUpdate(accessory, payload, function () {
                  return;
               });
            }, 500);
         } else {
            if (this.debug) {
               this.log("[%s] not sending off command as inched through eWeLink.", accessory.displayName);
            }
         }
         setTimeout(() => {
            service
               .updateCharacteristic(Characteristic.CurrentPosition, value)
               .updateCharacteristic(Characteristic.PositionState, 2);
            callback();
         }, blindConfig.operationTime * 100);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalGarageUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let garageConfig;
         if (!(garageConfig = this.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (garageConfig.type !== "garage" || !["oneSwitch", "twoSwitch"].includes(garageConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = garageConfig.sensorId || false;
         let sAccessory = false;
         if (sensorDefinition && !(sAccessory = this.devicesInHB.get(garageConfig.sensorId + "SWX"))) {
            throw "defined sensor doesn't exist";
         }
         if (garageConfig.setup === "oneSwitch" && !sAccessory) {
            throw "oneSwitch setup must have a defined sensor";
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {}
         };
         if (garageConfig.setup === "twoSwitch") {
            payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            payload.params.switches[0].switch = value === 0 ? "on" : "off";
            payload.params.switches[1].switch = value === 1 ? "on" : "off";
         } else {
            payload.params.switch = "on";
         }
         this.log("[%s] requesting to [%s].", accessory.displayName, value === 0 ? "open" : "close");
         this.sendDeviceUpdate(accessory, payload, function () {
            return;
         });
         accessory.getService(Service.GarageDoorOpener)
            .updateCharacteristic(Characteristic.TargetDoorState, value === 0 ? 0 : 1)
            .updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 2 : 3);
         if (!garageConfig.inched || garageConfig.inched === "false") {
            setTimeout(() => {
               payload.params.switch = "off";
               this.sendDeviceUpdate(accessory, payload, function () {
                  return;
               });
            }, 500);
         }
         if (!sAccessory) {
            setTimeout(() => {
               accessory.getService(Service.GarageDoorOpener)
                  .updateCharacteristic(Characteristic.CurrentDoorState, value === 0 ? 0 : 1);
               callback();
            }, parseInt(garageConfig.operationTime) * 100);
         } else {
            callback();
         }
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalFanUpdate(accessory, type, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let newPower, newSpeed, newLight, wsDelay;
         switch (type) {
         case "power":
            newPower = value;
            newSpeed = 33;
            newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
            wsDelay = 0;
            break;
         case "speed":
            newPower = value >= 33 ? 1 : 0;
            newSpeed = value;
            newLight = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value;
            wsDelay = 250;
            break;
         case "light":
            newPower = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active).value;
            newSpeed = accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value;
            newLight = value;
            wsDelay = 0;
            break;
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switches: this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches
            }
         };
         payload.params.switches[0].switch = newLight ? "on" : "off";
         payload.params.switches[1].switch = (newPower === 1 && newSpeed >= 33) ? "on" : "off";
         payload.params.switches[2].switch = (newPower === 1 && newSpeed >= 66 && newSpeed < 99) ? "on" : "off";
         payload.params.switches[3].switch = (newPower === 1 && newSpeed >= 99) ? "on" : "off";
         if (this.debug) {
            this.log("[%s] updating power [%s], speed [%s%], light [%s].", accessory.displayName, newPower, newSpeed, newLight);
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, newLight);
         accessory.getService(Service.Fanv2)
            .updateCharacteristic(Characteristic.Active, newPower)
            .updateCharacteristic(Characteristic.RotationSpeed, newSpeed);
         setTimeout(() => {
            this.sendDeviceUpdate(accessory, payload, callback);
         }, wsDelay);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalThermostatUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
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
         if (this.debug) {
            this.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
         this.sendDeviceUpdate(accessory, payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalOutletUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {
               switch: value ? "on" : "off"
            }
         };
         if (this.debug) {
            this.log("[%s] requesting to turn [%s].", accessory.displayName, value ? "on" : "off");
         }
         accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, value);
         this.sendDeviceUpdate(accessory, payload, callback);
      } catch (err) {
         callback("[" + accessory.displayName + "] " + err + ".");
      }
   }
   internalLightbulbUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let oAccessory;
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {}
         };
         switch (accessory.context.switchNumber) {
         case "X":
            if (accessory.context.eweUIID === 22) { //*** The B1 uses state instead of switch for some strange reason. ***\\
               payload.params.state = value ? "on" : "off";
            } else {
               payload.params.switch = value ? "on" : "off";
            }
            if (this.debug) {
               this.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            break;
         case "0":
            payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            payload.params.switches[0].switch = value ? "on" : "off";
            payload.params.switches[1].switch = value ? "on" : "off";
            payload.params.switches[2].switch = value ? "on" : "off";
            payload.params.switches[3].switch = value ? "on" : "off";
            if (this.debug) {
               this.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            for (let i = 1; i <= 4; i++) {
               if (this.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
                  oAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
                  oAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
               }
            }
            break;
         case "1":
         case "2":
         case "3":
         case "4":
            if (this.debug) {
               this.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, value);
            let tAccessory;
            let masterState = "off";
            payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            for (let i = 1; i <= 4; i++) {
               if ((tAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i))) {
                  i === parseInt(accessory.context.switchNumber) ?
                     payload.params.switches[i - 1].switch = value ? "on" : "off" :
                     payload.params.switches[i - 1].switch = tAccessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value ? "on" : "off";
                  if (tAccessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).value) {
                     masterState = "on";
                  }
               } else {
                  payload.params.switches[i - 1].switch = "off";
               }
            }
            oAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
            oAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, masterState === "on");
            break;
         default:
            throw "unknown switch number [" + accessory.context.switchNumber + "]";
         }
         this.sendDeviceUpdate(accessory, payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalBrightnessUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
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
         if (this.debug) {
            this.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
         }
         setTimeout(() => {
            this.sendDeviceUpdate(accessory, payload, callback);
         }, 250);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalHSBUpdate(accessory, type, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
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
            if (this.debug) {
               this.log("[%s] updating hue to [%s°].", accessory.displayName, value);
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
            if (this.debug) {
               this.log("[%s] updating brightness to [%s%].", accessory.displayName, value);
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
         setTimeout(() => {
            this.sendDeviceUpdate(accessory, payload, callback);
         }, 250);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   internalSwitchUpdate(accessory, value, callback) {
      try {
         if (!accessory.context.reachableWAN && !accessory.context.reachableLAN) {
            throw "it is currently offline";
         }
         let oAccessory;
         let payload = {
            apikey: accessory.context.eweApiKey,
            deviceid: accessory.context.eweDeviceId,
            params: {}
         };
         switch (accessory.context.switchNumber) {
         case "X":
            payload.params.switch = value ? "on" : "off";
            if (this.debug) {
               this.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            break;
         case "0":
            payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            payload.params.switches[0].switch = value ? "on" : "off";
            payload.params.switches[1].switch = value ? "on" : "off";
            payload.params.switches[2].switch = value ? "on" : "off";
            payload.params.switches[3].switch = value ? "on" : "off";
            if (this.debug) {
               this.log("[%s] updating to turn group [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            for (let i = 1; i <= 4; i++) {
               if (this.devicesInHB.has(accessory.context.eweDeviceId + "SW" + i)) {
                  oAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i);
                  oAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
               }
            }
            break;
         case "1":
         case "2":
         case "3":
         case "4":
            if (this.debug) {
               this.log("[%s] updating to turn [%s].", accessory.displayName, value ? "on" : "off");
            }
            accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, value);
            let tAccessory;
            let masterState = "off";
            payload.params.switches = this.devicesInEwe.get(accessory.context.eweDeviceId).params.switches;
            for (let i = 1; i <= 4; i++) {
               if ((tAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW" + i))) {
                  i === parseInt(accessory.context.switchNumber) ?
                     payload.params.switches[i - 1].switch = value ? "on" : "off" :
                     payload.params.switches[i - 1].switch = tAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value ? "on" : "off";
                  if (tAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value) {
                     masterState = "on";
                  }
               } else {
                  payload.params.switches[i - 1].switch = "off";
               }
            }
            oAccessory = this.devicesInHB.get(accessory.context.eweDeviceId + "SW0");
            oAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, masterState === "on");
            break;
         default:
            throw "unknown switch number [" + accessory.context.switchNumber + "]";
         }
         this.sendDeviceUpdate(accessory, payload, callback);
      } catch (err) {
         let str = "[" + accessory.displayName + "] could not be updated as " + err + ".";
         this.log.error(str);
         callback(str);
      }
   }
   externalBlindUpdate(accessory, params) {
      try {
         let blindConfig;
         if (!(blindConfig = this.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (blindConfig.type !== "blind" || blindConfig.setup !== "twoSwitch") {
            throw "improper configuration";
         }
         let switchUp = params.switches[0].switch === "on" ? -1 : 0; // matrix of numbers to get
         let switchDown = params.switches[1].switch === "on" ? 0 : 2; // ... the correct HomeKit value
         let currentState = switchUp + switchDown;
         let newPosition = currentState * 100; // ie newPosition is 0x0=0% if moving down or 1x100=100% if moving up
         accessory.getService(Service.WindowCovering)
            .updateCharacteristic(Characteristic.PositionState, currentState)
            .updateCharacteristic(Characteristic.TargetPosition, newPosition);
         setTimeout(() => {
            accessory.getService(Service.WindowCovering)
               .updateCharacteristic(Characteristic.PositionState, 2)
               .updateCharacteristic(Characteristic.CurrentPosition, newPosition);
         }, blindConfig.operationTime * 100);
         try {
            this.api.updatePlatformAccessories("homebridge-ewelink-sonoff", "eWeLink", [accessory]);
         } catch (e) {
            this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, e);
         }
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalGarageUpdate(accessory, params) {
      try {
         if (params.switch !== "on") {
            return;
         }
         let garageConfig;
         if (!(garageConfig = this.customGroups.get(accessory.context.hbDeviceId))) {
            throw "group config missing";
         }
         if (garageConfig.type !== "garage" || !["oneSwitch", "twoSwitch"].includes(garageConfig.setup)) {
            throw "improper configuration";
         }
         let sensorDefinition = garageConfig.sensorId || false;
         let sAccessory = false;
         if (sensorDefinition && !(sAccessory = this.devicesInHB.get(garageConfig.sensorId + "SWX"))) {
            throw "defined sensor doesn't exist";
         }
         if (garageConfig.setup === "oneSwitch" && !sAccessory) {
            throw "oneSwitch setup must have a defined sensor";
         }
         this.log("=== EXTERNAL GARAGE UPDATE [EGU] ===");
         this.log("EGU1/4: user config looks good so start procedure...");
         let currentPos;
         if (sAccessory) {
            this.log("EGU2/4: sensor [%s] will be used to determine initial garage position...", sAccessory.displayName);
            currentPos = sAccessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState).value;
            let temp_textString = currentPos === 0 ? "contact detected - garage closed" : "contact not detected - garage open";
            accessory.getService(Service.GarageDoorOpener)
               .updateCharacteristic(Characteristic.TargetDoorState, currentPos)
               .updateCharacteristic(Characteristic.CurrentDoorState, currentPos);
            this.log("EGU3/4: sensor reports a value of [%s] which corresponds to [%s].", currentPos, temp_textString);
            // 1 = contact not detected  -> garage open
            // 0 = contact detected      -> garage closed
            this.log("EGU4/4: nothing else to do here as will wait for sensor notification and update garage door accordingly.");
            this.log("=== EXTERNAL GARAGE UPDATE END ===");
         } else {
            currentPos = accessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.CurrentDoorState).value;
            accessory.getService(Service.GarageDoorOpener)
               .updateCharacteristic(Characteristic.TargetDoorState, currentPos === 0 ? 1 : 0)
               .updateCharacteristic(Characteristic.CurrentDoorState, currentPos === 0 ? 1 : 0);
         }
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSensorUpdate(accessory, params) {
      try {
         this.log.warn("This is debugging. Not an error.\n" + JSON.stringify(params, null, 2));
         let service = accessory.getService(Service.ContactSensor);
         let curState = service.getCharacteristic(Characteristic.ContactSensorState).value;
         // curState = 0 if contact detected (params.switch === "off")
         // curState = 1 if contact not dtcd (params.switch === "on")
         service.updateCharacteristic(Characteristic.ContactSensorState, params.switch === "on" ? 1 : 0);
         if ((curState === 0 && params.switch === "off") || (curState === 1 && params.switch === "on")) {
            return; // nothing to do as no change in state.
         }
         this.log("=== EXTERNAL SENSOR UPDATE [ESU] ===");
         this.log("ESU1 sensor has sent update that it is now [%s]", params.switch === "on" ? "apart" : "joined");
         // check to see if sensor is grouped with a blind/garage
         let oAccessory = false;
         this.customGroups.forEach(group => {
            if (group.sensorId === accessory.context.eweDeviceId && group.type === "garage") {
               // line below will work for "oneSwitch" scenario. TODO: "twoSwitch"
               if ((oAccessory = this.devicesInHB.get(group.deviceId + "SWX"))) {
                  // reminder curState from before
                  // 0 = contact detected -> garage closed
                  // 1 = contact not dtcd -> garage open
                  let currentDoorPos = oAccessory.getService(Service.GarageDoorOpener).getCharacteristic(Characteristic.CurrentDoorState).value;
                  // 0 = garage open
                  // 1 = garage closed
                  if (curState !== currentDoorPos) {
                     // this logic might seem wrong but the variables have their 0, 1 reversed.
                     // nothing to do as sensor value === garage state value.
                     return;
                  }
                  this.log("ESU2 sensor found linked to [%s] has noticed a change in state...", oAccessory.displayName);
                  if (params.switch === "on") {
                     this.log("ESU3 update [%s] has begun to open so wait for operationTime...", oAccessory.displayName);
                     // sensor has broken contact:
                     // 1. wait for the defined "operationTime" as per user config
                     setTimeout(() => {
                        this.log("ESU3 update [%s] to open as garage should be pretty much fully open...", oAccessory.displayName);
                        // 2. change accessory status from "opening" to "open"
                        oAccessory.getService(Service.GarageDoorOpener)
                           .updateCharacteristic(Characteristic.TargetDoorState, 0)
                           .updateCharacteristic(Characteristic.CurrentDoorState, 0);
                        this.log("=== EXTERNAL SENSOR UPDATE END ===");
                     }, (group.operationTime * 100));
                     this.log("ESU3 update [%s] to closed as sensor is joined...", oAccessory.displayName);
                  } else {
                     //1. immediately change accessory status from "closing" to "closed" (as operationTime has already happened)
                     oAccessory.getService(Service.GarageDoorOpener)
                        .updateCharacteristic(Characteristic.TargetDoorState, 1)
                        .updateCharacteristic(Characteristic.CurrentDoorState, 1);
                     this.log("=== EXTERNAL SENSOR UPDATE END ===");
                  }
               }
            }
         });
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalFanUpdate(accessory, params) {
      try {
         let light;
         let status = 0;
         let speed = 0;
         if (Array.isArray(params.switches)) {
            light = params.switches[0].switch === "on";
            switch (params.switches[1].switch+params.switches[2].switch+params.switches[3].switch) {
            case "onoffoff":
            default:
               status = 1;
               speed = 33;
               break;
            case "ononoff":
               status = 1;
               speed = 66;
               break;
            case "onoffon":
               status = 1;
               speed = 99;
            }
         } else if (params.hasOwnProperty("light") && params.hasOwnProperty("fan") && params.hasOwnProperty("speed")) {
            light = params.light === "on";
            status = params.fan === "on" ? 1 : 0;
            speed = params.speed * 33 * status;
         } else {
            throw "unknown parameters received";
         }
         accessory.getService(Service.Lightbulb)
            .updateCharacteristic(Characteristic.On, light);
         accessory.getService(Service.Fanv2)
            .updateCharacteristic(Characteristic.Active, status)
            .updateCharacteristic(Characteristic.RotationSpeed, speed);
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalThermostatUpdate(accessory, params) {
      try {
         if (params.hasOwnProperty("switch") || params.hasOwnProperty("mainSwitch")) {
            let newState = params.hasOwnProperty("switch") ? params.switch === "on" : params.mainSwitch === "on";
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
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalOutletUpdate(accessory, params) {
      try {
         accessory.getService(Service.Outlet).updateCharacteristic(Characteristic.On, params.switch === "on");
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSingleLightUpdate(accessory, params) {
      try {
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
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalMultiLightUpdate(accessory, params) {
      try {
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let primaryState = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (this.devicesInHB.has(idToCheck + i)) {
               let oAccessory = this.devicesInHB.get(idToCheck + i);
               oAccessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
               if (params.switches[i - 1].switch === "on") {
                  primaryState = true;
               }
            }
         }
         accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, primaryState);
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalSingleSwitchUpdate(accessory, params) {
      try {
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switch === "on");
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalMultiSwitchUpdate(accessory, params) {
      try {
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let primaryState = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (this.devicesInHB.has(idToCheck + i)) {
               let oAccessory = this.devicesInHB.get(idToCheck + i);
               oAccessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, params.switches[i - 1].switch === "on");
               if (params.switches[i - 1].switch === "on") {
                  primaryState = true;
               }
            }
         }
         accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, primaryState);
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
      }
   }
   externalBridgeUpdate(accessory, params) {
      try {
         let idToCheck = accessory.context.hbDeviceId.slice(0, -1);
         let timeNow = new Date();
         let master = false;
         for (let i = 1; i <= accessory.context.channelCount; i++) {
            if (this.devicesInHB.has(idToCheck + i)) {
               let oAccessory = this.devicesInHB.get(idToCheck + i);
               if (params.hasOwnProperty("rfTrig" + (i - 1))) {
                  let timeOfMotion = new Date(params["rfTrig" + (i - 1)]);
                  let timeDifference = (timeNow.getTime() - timeOfMotion.getTime()) / 1000;
                  if (timeDifference < this.sensorTimeDifference) {
                     switch (oAccessory.context.sensorType) {
                     case "water":
                        oAccessory.getService(Service.LeakSensor).updateCharacteristic(Characteristic.LeakDetected, 1);
                        break;
                     case "fire":
                     case "smoke":
                        oAccessory.getService(Service.SmokeSensor).updateCharacteristic(Characteristic.SmokeDetected, 1);
                        break;
                     case "co":
                        oAccessory.getService(Service.CarbonMonoxideSensor).updateCharacteristic(Characteristic.CarbonMonoxideDetected, 1);
                        break;
                     case "co2":
                        oAccessory.getService(Service.CarbonDioxideSensor).updateCharacteristic(Characteristic.CarbonDioxideDetected, 1);
                        break;
                     case "contact":
                        oAccessory.getService(Service.ContactSensor).updateCharacteristic(Characteristic.ContactSensorState, 1);
                        break;
                     case "occupancy":
                        oAccessory.getService(Service.OccupancySensor).updateCharacteristic(Characteristic.OccupancyDetected, 1);
                        break;
                     case "motion":
                     default:
                        oAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
                        break;
                     }
                     master = true;
                     if (this.debug) {
                        this.log("[%s] has detected [%s].", oAccessory.displayName, oAccessory.context.sensorType);
                     }
                  }
               }
            }
         }
         if (master) {
            accessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, true);
            setTimeout(() => {
               for (let i = 0; i <= accessory.context.channelCount; i++) {
                  if (this.devicesInHB.has(idToCheck + i)) {
                     let oAccessory = this.devicesInHB.get(idToCheck + i);
                     switch (oAccessory.context.sensorType) {
                     case "water":
                        oAccessory.getService(Service.LeakSensor).updateCharacteristic(Characteristic.LeakDetected, 0);
                        break;
                     case "fire":
                     case "smoke":
                        oAccessory.getService(Service.SmokeSensor).updateCharacteristic(Characteristic.SmokeDetected, 0);
                        break;
                     case "co":
                        oAccessory.getService(Service.CarbonMonoxideSensor).updateCharacteristic(Characteristic.CarbonMonoxideDetected, 0);
                        break;
                     case "co2":
                        oAccessory.getService(Service.CarbonDioxideSensor).updateCharacteristic(Characteristic.CarbonDioxideDetected, 0);
                        break;
                     case "contact":
                        oAccessory.getService(Service.ContactSensor).updateCharacteristic(Characteristic.ContactSensorState, 0);
                        break;
                     case "occupancy":
                        oAccessory.getService(Service.OccupancySensor).updateCharacteristic(Characteristic.OccupancyDetected, 0);
                        break;
                     case "motion":
                     default:
                        oAccessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, false);
                        break;
                     }
                  }
               }
            }, this.sensorTimeLength * 1000);
         }
      } catch (err) {
         this.log.warn("[%s] could not be updated - [%s].", accessory.displayName, err);
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
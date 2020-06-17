let WebSocket = require('ws');
let request = require('request-json');
let nonce = require('nonce')();
let crypto = require('crypto');
const querystring = require('querystring');

let wsc;
let sequence;
let webClient;
let Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
   Accessory = homebridge.platformAccessory;
   Service = homebridge.hap.Service;
   Characteristic = homebridge.hap.Characteristic;
   UUIDGen = homebridge.hap.uuid;
   homebridge.registerPlatform("homebridge-eWeLink", "eWeLink", eWeLink, true);
};

function eWeLink(log, config, api) {
   if (!config || (!config['username'] || !config['password'] || !config['countryCode'])) {
      log("Please check you have set your username, password and country code in the Homebridge config.");
      return;
   }
   this.log = log;
   this.config = config;
   this.apiKey = 'UNCONFIGURED';
   this.authenticationToken = 'UNCONFIGURED';
   this.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
   this.debug = this.config['debug'] || false;
   this.emailLogin = this.config['username'].includes("@") ? true : false;
   this.apiHost = (this.config['apiHost'] || 'eu-api.coolkit.cc') + ':8080';
   this.wsHost = this.config['wsHost'] || 'eu-pconnect3.coolkit.cc';
   this.groupDefs = new Map();
   this.webSocketOpen = false;
   this.devicesInHB = new Map();
   this.devicesInEwe = new Map();
   this.unsupportedDevices = [28];
   this.deviceGroups = new Map();
   this.groupDefaults = {
      "relay_up": 1,
      "relay_down": 2,
      "time_up": 40,
      "time_down": 20,
      "group.time_botton_margin_up": 0,
      "group.time_botton_margin_down": 0,
      "full_overdrive": 0
   };
   
   let platform = this;
   if (api) {
      platform.api = api;
      
      // Listen to event "didFinishLaunching", this means Homebridge has already finished loading cached accessories.
      // Platform plugin will register new accessories that don't already exist in Homebridge.
      platform.api.on('didFinishLaunching', function () {
         
         let afterLogin = function () {
            if (platform.debug) platform.log("Auth token received [%s].", platform.authenticationToken);
            if (platform.debug) platform.log("API key received [%s].", platform.apiKey);
            
            // Get a list of all devices from eWeLink via the HTTPS API, and compare it to the list of Homebridge cached devices (and then vice versa).
            // That is: new devices will be added, existing will be refreshed and those in the Homebridge cache but not in the web list will be removed.
            platform.log("[%s] eWeLink devices were loaded from the Homebridge cache.", platform.devicesInHB.size);
            platform.log("Requesting a list of devices through the eWeLink HTTP API...");
            
            platform.webClient = request.createClient('https://' + platform.apiHost);
            platform.webClient.headers['Authorization'] = 'Bearer ' + platform.authenticationToken;
            platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
               if (err) {
                  platform.log("An error occurred requesting devices through the API...");
                  platform.log("[%s].", err);
                  return;
               } else if (!body) {
                  platform.log("An error occurred requesting devices through the API...");
                  platform.log("[No data in response].");
                  return;
               } else if (body.hasOwnProperty('error') && body.error != 0) {
                  let response = JSON.stringify(body);
                  platform.log("An error occurred requesting devices through the API...");
                  if (body.error === '401') {
                     platform.log("[Authorisation token error].");
                  } else {
                     platform.log("[%s].", response);
                  }
                  return;
               }
               let eWeLinkDevices = body.devicelist;
               let primaryDeviceCount = Object.keys(eWeLinkDevices).length;
               if (primaryDeviceCount === 0) {
                  platform.log("[0] primary devices were loaded from your eWeLink account. Devices will be removed from Homebridge.");
                  platform.api.unregisterPlatformAccessories("homebridge-eWeLink", "eWeLink", Array.from(platform.devicesInHB.values()));
                  platform.devicesInHB.clear();
                  return;
               }
               eWeLinkDevices.forEach((device) => {
                  if (!platform.unsupportedDevices.includes(device.uiid)) {
                     platform.devicesInEwe.set(device.deviceid, device);
                  }
               });
               if (platform.config['groups'] && Object.keys(platform.config['groups']).length > 0) {
                  platform.config.groups.forEach((group) => {
                     if (typeof group.deviceId !== 'undefined' && platform.devicesInEwe.has(group.deviceId + "SWX")) {
                        platform.deviceGroups.set(group.deviceId + "SWX", group);
                     }
                  });
               }
               platform.log("[%s] primary devices were loaded from your eWeLink account.", primaryDeviceCount);
               platform.log("[%s] groups were loaded from the Homebridge configuration.", platform.deviceGroups.size);
               
               // Here we check that each accessory in the Homebridge cache does in fact appear in the API response
               // platform.devicesInHB (the cached accessories) has already been set up.
               if (platform.devicesInHB.size > 0) {
                  function hbToEwe (accessory, deviceId, map) {
                     let hbDeviceId;
                     hbDeviceId = deviceId.slice(0, -3);
                     if (platform.devicesInEwe.has(hbDeviceId)) {
                        if (platform.deviceGroups.has(hbDeviceId)) { // BLINDS //
                           let group = platform.deviceGroups.get(hbDeviceId);
                           if (group.type == 'blind') {
                              platform.log('[%s] is part of a blind so hiding from Homebridge.', accessory.displayName);
                              platform.removeAccessory(accessory);
                           }
                        } else if (platform.devicesInEwe.get(hbDeviceId).uiid === 34 && accessory.context.channel !== null) { // FANS //
                           platform.log('[%s] is part of a fan so hiding from Homebridge.', accessory.displayName);
                           platform.removeAccessory(accessory);
                        }
                     } else { // OTHER SUPPORTED DEVICES //
                        platform.log('[%s] was not present in the API response so removing from Homebridge.', accessory.displayName);
                        platform.removeAccessory(accessory);
                     }
                  };
                  if (platform.debug) platform.log("Checking if devices need to be removed from the Homebridge cache...");
                  platform.devicesInHB.forEach(hbToEwe);
               }
               // Now the reverse. Checking that each device from the API exists in Homebridge, otherwise we will add it to Homebridge.
               if (platform.devicesInEwe.size > 0) {
                  function eweToHB (device, deviceId, map) {
                     let services = {};
                     let i = 0;
                     if (platform.devicesInHB.has(device.deviceid + "SWX")) {                      //Here yes the API device exists in Homebridge so refreshing.
                        let accessory = platform.devicesInHB.get(device.deviceid + "SWX");
                        if (platform.debug) platform.log("[%s] is already configured so we just need to refresh it's characteristics.", accessory.displayName);
                        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                        if (platform.deviceGroups.has(device.deviceid + "SWX")) { // BLINDS //
                           let group = platform.deviceGroups.get(device.deviceid + "SWX");
                           if (group.type == 'blind') {
                              platform.updateBlindTargetPosition(device.deviceid + "SWX", device.params.switches);
                              platform.prepareBlindSwitchConfig(accessory); // TODO could this function be merged into the above?
                           }           
                        } else if (device.uiid == 34) { // FANS // 
                           platform.updateFanLight(device.deviceid + "SWX", device.params.switches[0].switch, device);
                           platform.updateFanSpeed(device.deviceid + "SWX", device.params.switches[1].switch, device.params.switches[2].switch, device.params.switches[3].switch, device);
                        } else if (device.extra.extra.model === "PSA-BHA-GL") { // THERMOSTATS //
                           platform.updateTempAndHumidity(device.deviceid + "SWX", device.params);
                           
                        } else { // OTHER SINGLE-SWITCH SUPPORTED DEVICES //
                           platform.updatePowerState(device.deviceid + "SWX", device.params.switch, false);
                        }        
                        if (platform.debug) platform.log("[%s] has been refreshed.", accessory.displayName);                
                     } else if (platform.devicesInHB.has(device.deviceid + "SW0")) { // OTHER MULTI-SWITCH SUPPORTED DEVICES //
                        channelCount = platform.getDeviceChannelCount(device);
                        primaryState = "off";
                        for (i = 1; i <= channelCount; i++) {
                           if (platform.devicesInHB.has(device.deviceid + "SW" + i)) {
                              let accessory = platform.devicesInHB.get(device.deviceid + "SW" + i);
                              if (platform.debug) platform.log("[%s] is already configured so we just need to refresh it's characteristics.", accessory.displayName);
                              accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                              platform.updatePowerState(device.deviceid + "SW" + i, device.params.switches[i - 1].switch, false);
                              if (device.params.switches[i - 1].switch == 'on') primaryState = "on";
                              if (platform.debug) platform.log("[%s] has been refreshed.", accessory.displayName);      
                           }
                        }
                        let accessory = platform.devicesInHB.get(device.deviceid + "SW0");
                        if (platform.debug) platform.log("[%s] is already configured so we just need to refresh it's characteristics.", accessory.displayName);
                        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
                        platform.updatePowerState(device.deviceid + "SW0", primaryState, false);
                        if (platform.debug) platform.log("[%s] has been refreshed.", accessory.displayName);                          
                     } else { // Here we have a device in the API that doesn't exist. So adding.
                     let channelCount;
                     let i = 0;
                     if (platform.deviceGroups.has(device.deviceid)) { // BLINDS //
                        if (group.type == 'blind') {
                           services.blind = true;
                           services.switch = false;
                           services.group = group;        
                           platform.addAccessory(device, device.deviceid + "SWX", services);            
                        }
                     } else if (device.uiid == 34) { // FANS //
                        services.fan = true;
                        services.switch = false;
                        platform.addAccessory(device, device.deviceid + "SWX", services);
                     } else if (device.extra.extra.model === "PSA-BHA-GL") { // THERMOSTATS //
                        services.thermostat = true;
                        services.temperature = true;
                        services.humidity = true;
                        services.switch = false;
                        platform.addAccessory(device, device.deviceid + "SWX", services);
                     } else {
                        
                        services.switch = true;
                        channelCount = platform.getDeviceChannelCount(device);
                        if (channelCount == 1) {
                           platform.addAccessory(device, device.deviceid + "SWX", services);
                        }
                        else {
                           for (i = 0; i <= channelCount; i++) {
                              platform.addAccessory(device, device.deviceid + "SW" + i, services);
                           }
                        }
                     }
                     if (platform.debug) platform.log("[%s] will be added to Homebridge.", device.name);                
                  }
               };
               if (platform.debug) platform.log("Checking if devices need to be added/refreshed in the Homebridge cache...");                  
               platform.devicesInEwe.forEach(eweToHB);
            }
            // All done. Next job - let's open a web socket connection to eWeLink.
            if (platform.debug) platform.log("Opening web socket for real time updates.");
            platform.wsc = new WebSocketClient();
            platform.wsc.open('wss://' + platform.wsHost + ':8080/api/ws');
            platform.wsc.onmessage = function (message) {
               if (platform.debug) platform.log("Web socket message received:");
               if (platform.debug) platform.log("[%s]", message);
               if (message == 'pong') {
                  return;
               }
               let json;
               try {
                  json = JSON.parse(message);
               } catch (e) {
                  return;
               }
               if (json.hasOwnProperty("action")) {
                  if (json.action === 'update' && json.hasOwnProperty("params")) {
                     if (platform.debug) platform.log("External update received via web socket.");
                     if (platform.devicesInHB.has(json.deviceid + "SW0") || platform.devicesInHB.has(json.deviceid + "SWX")) {
                        let device = platform.devicesInEwe.get(json.deviceid);
                        let deviceType = platform.getDeviceTypeByUiid(device.uiid);
                        let switchCount = platform.getDeviceChannelCount(device);
                        
                        if (json.params.hasOwnProperty("switches") && Array.isArray(json.params.switches)) {
                           if (platform.deviceGroups.has(json.deviceid)) { // BLINDS //
                              let group = platform.deviceGroups.get(json.deviceid);
                              if (group.type == 'blind') {
                                 platform.updateBlindTargetPosition(json.deviceid, json.params.switches);
                              }
                           }
                           else if (platform.devicesInEwe.get(json.deviceid).uiid === 34) { // FANS //
                              platform.updateFanLight(json.deviceid, json.params.switches[0].switch, platform.devicesInEwe.get(json.deviceid));
                              platform.devicesInEwe.get(json.deviceid).params.switches = json.params.switches;
                              platform.updateFanSpeed(json.deviceid, json.params.switches[1].switch, json.params.switches[2].switch, json.params.switches[3].switch, platform.devicesInEwe.get(json.deviceid));
                           } else { // OTHER MULTI-SWITCH SUPPORTED DEVICES
                              switchCount = platform.getDeviceChannelCount(device);
                              primaryOn = 'off';
                              for (let i = 0; i !== switchCount; i++) {
                                 isOn = json.params.switches[i].switch === 'on' ? true : false;
                                 platform.updatePowerState(json.deviceid + 'SW' + (i + 1), json.params.switches[i].switch, true);
                                 if (isOn) primaryOn = 'on';
                              }
                              platform.updatePowerState(json.deviceid + "SW0", primaryOn, true);
                           }
                        } else if (json.params.hasOwnProperty("switch")) { // OTHER SINGLE-SWITCH SUPPORTED DEVICES //
                           platform.updatePowerState(json.deviceid + "SWX", json.params.switch, true);
                        }
                        if (json.hasOwnProperty("extra") && json.extra.hasOwnProperty("extra") && json.extra.extra.hasOwnProperty("model") && json.extra.extra.model === "PSA-BHA-GL") { // THERMOSTATS //
                           platform.updateTempAndHumidity(json.deviceid, json.params);
                        }
                     } else {
                        if (platform.debug) platform.log("Accessory received via web socket does not exist in Homebridge.");
                     }
                  } else {
                     if (platform.debug) platform.log("Unknown action property or no params received via web socket.");
                  }
               } else if (json.hasOwnProperty("config") && json.config.hb && json.config.hbInterval) {
                  if (!platform.hbInterval) {
                     platform.hbInterval = setInterval(function () {
                        platform.wsc.send("ping");
                     }, json.config.hbInterval * 1000);
                  }
               } else {
                  if (platform.debug) platform.log("Unknown command received via web socket.");
               }
            };
            platform.wsc.onopen = function (e) {
               platform.webSocketOpen = true;
               let payload = {};
               payload.action = "userOnline";
               payload.at = platform.authenticationToken;
               payload.apikey = platform.apiKey;
               payload.appid = platform.appid;
               payload.nonce = '' + nonce();
               payload.ts = '' + Math.floor(new Date() / 1000);
               payload.userAgent = 'app';
               payload.sequence = platform.getSequence();
               payload.version = 8;
               let string = JSON.stringify(payload);
               if (platform.debug) platform.log('Sending web socket login request [%s].', string);
               platform.wsc.send(string);
            };
            platform.wsc.onclose = function (e) {
               platform.log("Web socket was closed [%s].", e);
               platform.webSocketOpen = false;
               if (platform.hbInterval) {
                  clearInterval(platform.hbInterval);
                  platform.hbInterval = null;
               }
            };
         });
      };
      platform.getRegion(platform.config['countryCode'], function () {
         platform.login(afterLogin.bind(platform));
      }.bind(this));
   }.bind(this));
}
}

eWeLink.prototype.addAccessory = function (device, hbDeviceId, services) {
   // Sample function to show how developer can add accessory dynamically from outside event
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (platform.devicesInHB.get(hbDeviceId)) {
      platform.log("Not adding [%s] as it already exists in the Homebridge cache.", hbDeviceId);
      return;
   }
   if (device.type != 10) {
      platform.log("Not adding [%s] as it is not compatible with this plugin.", hbDeviceId);
      return;
   }
   let channelCount;
   let switchNumber; //X, 0, 1, 2, 3, 4
   let status;
   let newDeviceName;
   
   channelCount = platform.getDeviceChannelCount(device);
   switchNumber = hbDeviceId.substr(-1);
   switch (switchNumber) {
      case "X":
      status = device.params.switch;
      newDeviceName = device.name;
      break;
      case "0":
      status = (device.params.switches[0].switch == 'on' || device.params.switches[1].switch == 'on' || device.params.switches[2].switch == 'on' || device.params.switches[3].switch == 'on') ? 'on' : 'off';
      newDeviceName = device.name;
      break;
      case "1":
      case "2":
      case "3":
      case "4":
      newDeviceName = device.name + " SW" + switchNumber;
      status = device.params.switches[parseInt(switchNumber) - 1].switch;
      break;
   }
   
   status = status === undefined ? 'off' : status;
   platform.log("[%s] has been added which is currently [%s].", newDeviceName, status);
   if (switchNumber > channelCount) {
      platform.log("[%s] has not been added since the [%s] only has [%s] switches].", newDeviceName, device.productModel, channelCount);
      return;
   }
   const accessory = new Accessory(newDeviceName, UUIDGen.generate(hbDeviceId).toString());
   
   accessory.context.deviceId = hbDeviceId;
   accessory.context.apiKey = device.apikey;
   accessory.context.switches = 1;
   accessory.context.channel = switchNumber - 1;
   
   accessory.reachable = device.online === 'true';
   
   if (services.switch) {
      let switchDevice = accessory.addService(Service.Switch, newDeviceName);
      switchDevice.getCharacteristic(Characteristic.On).updateValue(status == 'on' ? true : false);
   }
   if (services.fan) {
      let fan = accessory.addService(Service.Fanv2, newDeviceName);
      var light = accessory.addService(Service.Lightbulb, newDeviceName);
      
      fan.getCharacteristic(Characteristic.On)
      .on("get", function (callback) {
         platform.getFanState(accessory, callback);
      })
      .on("set", function (value, callback) {
         platform.setFanState(accessory, value, callback);
      });
      
      // This is actually the fan speed instead of rotation speed but HomeKit fan does not support this
      fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({
         minStep: 3
      })
      .on("get", function (callback) {
         platform.getFanSpeed(accessory, callback);
      })
      .on("set", function (value, callback) {
         platform.setFanSpeed(accessory, value, callback);
      });
      
      light.getCharacteristic(Characteristic.On)
      .on("get", function (callback) {
         platform.getFanLightState(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setFanLightState(accessory, value, callback);
      });
   }
   if (services.thermostat) {
      let thermostat = accessory.addService(Service.Thermostat, newDeviceName);
      thermostat.getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', function (callback) {
         platform.getTemperatureState(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setTemperatureState(accessory, value, callback);
      });
      
      thermostat.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', function (callback) {
         platform.getHumidityState(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setHumidityState(accessory, value, callback);
      });
   }
   if (services.temperature) {
      let tempSensor = accessory.addService(Service.TemperatureSensor, newDeviceName);
      tempSensor.getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', function (callback) {
         platform.getTemperatureState(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setTemperatureState(accessory, value, callback);
      });
   }
   
   if (services.humidity) {
      let humiditySensor = accessory.addService(Service.HumiditySensor, newDeviceName);
      humiditySensor.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', function (callback) {
         platform.getHumidityState(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setHumidityState(accessory, value, callback);
      });
   }
   if (services.blind) {
      
      accessory.context.switchUp = (services.group.relay_up || platform.groupDefaults['relay_up']) - 1;
      accessory.context.switchDown = (services.group.relay_down || platform.groupDefaults['relay_down']) - 1;
      accessory.context.durationUp = services.group.time_up || platform.groupDefaults['time_up'];
      accessory.context.durationDown = services.group.time_down || platform.groupDefaults['time_down'];
      accessory.context.durationBMU = services.group.time_bottom_margin_up || platform.groupDefaults['time_bottom_margin_up'];
      accessory.context.durationBMD = services.group.time_bottom_margin_down || platform.groupDefaults['time_bottom_margin_down'];
      accessory.context.fullOverdrive = services.group.full_overdrive || platform.groupDefaults['full_overdrive'];
      accessory.context.percentDurationDown = (accessory.context.durationDown / 100) * 1000;
      accessory.context.percentDurationUp = (accessory.context.durationUp / 100) * 1000;
      
      accessory.context.lastPosition = 100; // Last known position (0-100%).
      accessory.context.currentPositionState = 2; // 0 = Moving up, 1 = Moving down, 2 = Not moving.
      accessory.context.currentTargetPosition = 100; // Target position (0-100%).
      
      // Ensuring switches device config
      platform.prepareBlindSwitchConfig(accessory);
      
      var blind = accessory.addService(Service.WindowCovering, newDeviceName);
      blind.getCharacteristic(Characteristic.CurrentPosition)
      .on('get', function (callback) {
         platform.getBlindPosition(accessory, callback);
      });
      
      blind.getCharacteristic(Characteristic.PositionState)
      .on('get', function (callback) {
         platform.getBlindMovementState(accessory, callback);
      });
      
      blind.getCharacteristic(Characteristic.TargetPosition)
      .on('get', function (callback) {
         platform.getBlindTargetPosition(accessory, callback);
      })
      .on('set', function (value, callback) {
         platform.setBlindTargetPosition(accessory, value, callback);
      });
   }
   accessory.on('identify', function (paired, callback) {
      platform.log("[%s] identified. Identification on device not supported.", accessory.displayName);
      try {
         callback();
      } catch (e) {}
   });
   
   // Exception when a device is not ready to register
   try {
      accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.SerialNumber, hbDeviceId);
      accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, device.brandName);
      accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Model, device.productModel + ' (' + device.extra.extra.model + ')');
      accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Identify, false);
      accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
   } catch (e) {
      platform.log("[%s] has not been added [%s].", accessory.displayName, e);
   }
   
   platform.devicesInHB.set(hbDeviceId, accessory);
   platform.api.registerPlatformAccessories("homebridge-eWeLink", "eWeLink", [accessory]);
};

eWeLink.prototype.configureAccessory = function (accessory) {
   
   // Function invoked when Homebridge tries to restore cached accessory.
   // We update the existing devices as part of didFinishLaunching(), as to avoid an additional call to the the HTTPS API.
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   if (platform.debug) platform.log("Configuring cached accessory [%s].", accessory.displayName);
   
   let service;
   
   if (accessory.getService(Service.Switch)) {
      service = accessory.getService(Service.Switch);
      service.getCharacteristic(Characteristic.On).on('set', function (value, callback) {
         platform.setPowerState(accessory, value, callback);
      });
   }
   
   if (accessory.getService(Service.Fanv2)) {
      service = accessory.getService(Service.Fanv2);
      service.getCharacteristic(Characteristic.On).on("set", function (value, callback) {
         platform.setFanState(accessory, value, callback);
      });
      service.getCharacteristic(Characteristic.RotationSpeed).setProps({minStep: 3}).on("set", function (value, callback) {
         platform.setFanSpeed(accessory, value, callback);
      });
   }
   
   if (accessory.getService(Service.Lightbulb)) {
      service = accessory.getService(Service.Lightbulb);
      service.getCharacteristic(Characteristic.On).on("set", function (value, callback) {
         platform.setFanLightState(accessory, value, callback);
      });
   }
   
   if (accessory.getService(Service.Thermostat)) {
      service = accessory.getService(Service.Thermostat);
      service.getCharacteristic(Characteristic.CurrentTemperature).on('set', function (value, callback) {
         platform.setTemperatureState(accessory, value, callback);
      });
      service.getCharacteristic(Characteristic.CurrentRelativeHumidity).on('set', function (value, callback) {
         platform.setHumidityState(accessory, value, callback);
      });
   }
   if (accessory.getService(Service.TemperatureSensor)) {
      service = accessory.getService(Service.TemperatureSensor);
      service.getCharacteristic(Characteristic.CurrentTemperature).on('set', function (value, callback) {
         platform.setTemperatureState(accessory, value, callback);
      });
   }
   if (accessory.getService(Service.HumiditySensor)) {
      service = accessory.getService(Service.HumiditySensor);
      service.getCharacteristic(Characteristic.CurrentRelativeHumidity).on('set', function (value, callback) {
         platform.setHumidityState(accessory, value, callback);
      });
   }
   
   if (accessory.getService(Service.WindowCovering)) {
      service = accessory.getService(Service.WindowCovering);
      service.getCharacteristic(Characteristic.TargetPosition).on('set', function (value, callback) {
         platform.setBlindTargetPosition(accessory, value, callback);
      });
      
      let lastPosition = accessory.context.lastPosition;
      if ((lastPosition === undefined) || (lastPosition < 0)) {
         lastPosition = 0;
      }
      if (platform.debug) platform.log("[%s] cached position was [%s].", accessory.displayName, lastPosition);
      accessory.context.lastPosition = lastPosition;
      accessory.context.currentTargetPosition = lastPosition;
      accessory.context.currentPositionState = 2;
      
      let group = platform.deviceGroups.get(accessory.context.deviceId);
      if (group) {
         accessory.context.switchUp = (group.relay_up || platform.groupDefaults['relay_up']) - 1;
         accessory.context.switchDown = (group.relay_down || platform.groupDefaults['relay_down']) - 1;
         accessory.context.durationUp = group.time_up || platform.groupDefaults['time_up'];
         accessory.context.durationDown = group.time_down || platform.groupDefaults['time_down'];
         accessory.context.durationBMU = group.time_bottom_margin_up || platform.groupDefaults['time_bottom_margin_up'];
         accessory.context.durationBMD = group.time_bottom_margin_down || platform.groupDefaults['time_bottom_margin_down'];
         accessory.context.fullOverdrive = platform.groupDefaults['full_overdrive'];
         accessory.context.percentDurationDown = (accessory.context.durationDown / 100) * 1000;
         accessory.context.percentDurationUp = (accessory.context.durationUp / 100) * 1000;
      }
   }
   platform.devicesInHB.set(accessory.context.deviceId, accessory);
};

eWeLink.prototype.removeAccessory = function (accessory) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   platform.devicesInHB.delete(accessory.context.deviceId);
   platform.api.unregisterPlatformAccessories('homebridge-eWeLink', 'eWeLink', [accessory]);
   platform.log("[%s] has been removed from Homebridge.", accessory.displayName);
};

eWeLink.prototype.updatePowerState = function (hbDeviceId, newState, external) {
   
   // Used when we receive an update from an external source
   let platform = this;
   if (!platform.log) {
      return;
   }
   let accessory = platform.devicesInHB.get(hbDeviceId);
   if (!accessory) {
      platform.log("Error updating device with ID [%s] as it is not in Homebridge.", hbDeviceId);
      return;
   }
   let isOn = newState === 'on' ? true : false;
   if (external)
   {
      platform.log("[%s] has been turned [%s] from an external source.", accessory.displayName, newState);
   } else {
      platform.log("[%s] has been refreshed to [%s].", accessory.displayName, newState);
   }
   accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
};

eWeLink.prototype.updateTempAndHumidity = function (deviceId, state, device = null, channel = null) {
   
   // Used when we receive an update from an external source
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let accessory = platform.devicesInHB.get(deviceId);
   if (!accessory) {
      platform.log("Error updating device with ID [%s] as it is not in Homebridge.", deviceId);
      return;
   }
   
   let currentTemperature = state.currentTemperature;
   let currentHumidity = state.currentHumidity;
   
   platform.log("Updating 'Characteristic.CurrentTemperature' for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, currentTemperature);
   platform.log("Updating 'Characteristic.CurrentRelativeHumiditgy' for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, currentHumidity);
   
   if (accessory.getService(Service.Thermostat)) {
      accessory.getService(Service.Thermostat)
      .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
      accessory.getService(Service.Thermostat)
      .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
   }
   if (accessory.getService(Service.TemperatureSensor)) {
      accessory.getService(Service.TemperatureSensor)
      .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
   }
   if (accessory.getService(Service.HumiditySensor)) {
      accessory.getService(Service.HumiditySensor)
      .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
   }
};

eWeLink.prototype.updateBlindTargetPosition = function (deviceId, switches, device = null) {
   
   // Used when we receive an update from an external source
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let accessory = platform.devicesInHB.get(deviceId);
   if (!accessory) {
      platform.log("Error updating device with ID [%s] as it is not in Homebridge.", deviceId);
      return;
   }
   
   let state = platform.prepareBlindState(switches, accessory);
   // platform.log("blindState_debug:", state)
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => Error
   
   let stateString = ["Moving up", "Moving down", "Stopped", "Error!"];
   let service = accessory.getService(Service.WindowCovering);
   let actualPosition;
   
   // platform.log("accessory.context.currentPositionState:", accessory.context.currentPositionState);
   
   switch (state) {
      case 3:
      platform.log("Error with [%s] - 'positionState' is %s. Force stop.", accessory.displayName, state);
      actualPosition = platform.prepareBlindPosition(accessory);
      accessory.context.currentTargetPosition = actualPosition;
      accessory.context.targetTimestamp = Date.now() + 10;
      service.setCharacteristic(Characteristic.TargetPosition, actualPosition);
      break;
      case 2:
      if (accessory.context.currentPositionState == 2) {
         platform.log("[%s] received new 'positionState' [%s - %s]. Already stopped. Nothing to do.", accessory.displayName, state, stateString[state]);
         return;
      }
      actualPosition = platform.prepareBlindPosition(accessory);
      platform.log("[%s] received new 'positionState' when moving [%s - %s]. Target position is [%s]", accessory.displayName, state, stateString[state], actualPosition);
      accessory.context.currentTargetPosition = actualPosition;
      accessory.context.targetTimestamp = Date.now() + 10;
      service.setCharacteristic(Characteristic.TargetPosition, actualPosition);
      break;
      case 1:
      if (accessory.context.currentPositionState == 1) {
         platform.log("[%s] received new 'positionState' [%s - %s]. Nothing to do.", accessory.displayName, state, stateString[state]);
         return;
      }
      if (accessory.context.currentTargetPosition == 0) {
         platform.log("[%s] received new 'positionState' [%s - %s]. Target position is already 0. Stopping.", accessory.displayName, state, stateString[state]);
         platform.prepareBlindFinalState(accessory);
      } else {
         platform.log("[%s] received new 'positionState' [%s - %s]. Target position is 0.", accessory.displayName, state, stateString[state]);
         service.setCharacteristic(Characteristic.TargetPosition, 0);
      }
      break;
      case 0:
      if (accessory.context.currentPositionState == 0) {
         platform.log("[%s] received new 'positionState' [%s - %s]. Nothing to do.", accessory.displayName, state, stateString[state]);
         return;
      }
      if (accessory.context.currentTargetPosition == 100) {
         platform.log("[%s] received new 'positionState' [%s - %s]. Target position is already 100. Stopping.", accessory.displayName, state, stateString[state]);
         platform.prepareBlindFinalState(accessory);
      } else {
         platform.log("[%s] received new 'positionState' [%s - %s]. Target position is 100.", accessory.displayName, state, stateString[state]);
         service.setCharacteristic(Characteristic.TargetPosition, 100);
      }
      break;
      default:
      platform.log("Error with 'positionState' type for [%s].", accessory.displayName);
      break;
   }
};

eWeLink.prototype.updateFanLight = function (deviceId, state, device = null) {
   
   // Used when we receive an update from an external source
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let accessory = platform.devicesInHB.get(deviceId);
   if (!accessory) {
      platform.log("Error updating device with ID [%s] as it is not in Homebridge.", deviceId);
      return;
   }
   
   if (state === 'on') {
      isOn = true;
   }
   
   platform.log("Updating 'Characteristic.On' for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);
   
   accessory.getService(Service.Lightbulb)
   .setCharacteristic(Characteristic.On, isOn);
   
};

eWeLink.prototype.updateFanSpeed = function (deviceId, state1, state2, state3, device = null) {
   
   // Used when we receive an update from an external source
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let accessory = platform.devicesInHB.get(deviceId);
   if (!accessory) {
      platform.log("Error updating device with ID [%s] as it is not in Homebridge.", deviceId);
      return;
   }
   
   if (state1 === 'on' && state2 === 'off' && state3 === 'off') {
      isOn = true;
      speed = 33.0;
   } else if (state1 === 'on' && state2 === 'on' && state3 === 'off') {
      isOn = true;
      speed = 66.0;
   } else if (state1 === 'on' && state2 === 'off' && state3 === 'on') {
      isOn = true;
      speed = 100.0;
   }
   
   platform.log("Updating 'Characteristic.On' for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);
   platform.log("Updating 'Characteristic.RotationSpeed' for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, speed);
   
   accessory.getService(Service.Fanv2)
   .setCharacteristic(Characteristic.On, isOn);
   
   accessory.getService(Service.Fanv2)
   .setCharacteristic(Characteristic.RotationSpeed, speed);
};

eWeLink.prototype.getFanLightState = function (accessory, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining fan light status for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting fan light status for [%s]...", accessory.displayName);
   
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getFanLightState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting fan light status for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting fan light status for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting fan light status for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting fan light status for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      
      if (body.length < 1) {
         callback('An error occurred while requesting fan light status for your device');
         accessory.reachable = false;
         return;
      }
      
      let deviceId = accessory.context.deviceId;
      
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         
         let device = filteredResponse[0];
         
         if (device.deviceid === deviceId) {
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API.", accessory.displayName);
               callback("API reported that [%s] is not online", device.name);
               return;
            }
            
            if (device.params.switches[0].switch === 'on') {
               accessory.reachable = true;
               platform.log("API reported that [%s] is [on].", device.name);
               callback(null, 1);
               return;
            } else if (device.params.switches[0].switch === 'off') {
               accessory.reachable = true;
               platform.log("API reported that [%s] is [off].", device.name);
               callback(null, 0);
               return;
            } else {
               accessory.reachable = false;
               platform.log("API reported an unknown status for [%s].", accessory.displayName);
               callback("API returned an unknown status for " + accessory.displayName);
               return;
            }
         }
         
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting fan light status for your device');
      }
   });
};

eWeLink.prototype.getTemperatureState = function (accessory, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining temperature for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting temperature for [%s]...", accessory.displayName);
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getTemperatureState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting temperature for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting temperature for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting temperature for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting temperature for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      
      if (body.length < 1) {
         callback('An error occurred while requesting temperature for your device');
         accessory.reachable = false;
         return;
      }
      
      let deviceId = accessory.context.deviceId;
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         
         let device = filteredResponse[0];
         
         if (device.deviceid === deviceId) {
            
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API.", accessory.displayName);
               callback("API reported that [%s] is not online", device.name);
               return;
            }
            
            let currentTemperature = device.params.currentTemperature;
            
            if (accessory.getService(Service.Thermostat)) {
               accessory.getService(Service.Thermostat)
               .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
            }
            if (accessory.getService(Service.TemperatureSensor)) {
               accessory.getService(Service.TemperatureSensor)
               .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
            }
            platform.log("API reported that [%s] temperature is [%s].", device.name, currentTemperature);
            accessory.reachable = true;
            callback(null, currentTemperature);
            
         }
         
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting temperature for your device');
      }
   });
   
};

eWeLink.prototype.getFanState = function (accessory, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining fan status for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting fan status for [%s]...", accessory.displayName);
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getFanState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting fan status for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting fan status for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting fan status for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting fan status for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      
      if (body.length < 1) {
         callback('An error occurred while requesting fan status for your device');
         accessory.reachable = false;
         return;
      }
      
      let deviceId = accessory.context.deviceId;
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         
         let device = filteredResponse[0];
         
         if (device.deviceid === deviceId) {
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API.", accessory.displayName);
               callback("API reported that [%s] is not online", device.name);
               return;
            }
            
            if (device.params.switches[1].switch === 'on') {
               accessory.reachable = true;
               platform.log("API reported that [%s] is [on].", device.name);
               callback(null, 1);
               return;
            } else if (device.params.switches[1].switch === 'off') {
               accessory.reachable = true;
               platform.log("API reported that [%s] is [off].", device.name);
               callback(null, 0);
               return;
            } else {
               accessory.reachable = false;
               platform.log("API reported an unknown status for [%s - %s].", accessory.displayName, device.params.switches[1].switch);
               callback("API returned an unknown status for device " + accessory.displayName);
               return;
            }
         }
         
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting fan status for your device');
      }
   });
};

eWeLink.prototype.getFanSpeed = function (accessory, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining fan speed for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting fan speed for [%s]...", accessory.displayName);
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getFanSpeed(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting fan speed for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting fan speed for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting fan speed for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting fan speed for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      
      if (body.length < 1) {
         callback('An error occurred while requesting fan speed for your device');
         accessory.reachable = false;
         return;
      }
      
      let deviceId = accessory.context.deviceId;
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         
         let device = filteredResponse[0];
         
         if (device.deviceid === deviceId) {
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API.", accessory.displayName);
               callback("API reported that [%s] is not online", device.name);
               return;
            }
            
            if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'off') {
               accessory.reachable = true;
               platform.log("API reported that [%s] speed is [33].", device.name);
               callback(null, 33);
               return;
            } else if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'on' && device.params.switches[3].switch === 'off') {
               accessory.reachable = true;
               platform.log("API reported that [%s] speed is [66].", device.name);
               callback(null, 66);
               return;
            } else if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'on') {
               accessory.reachable = true;
               platform.log("API reported that [%s] speed is [100].", device.name);
               callback(null, 100);
               return;
            } else {
               accessory.reachable = false;
               platform.log("API reported an unknown status for [%s].", accessory.displayName);
               callback('API returned an unknown status for device ' + accessory.displayName);
               return;
            }
         }
         
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting fan speed for your device');
      }
   });
};

eWeLink.prototype.getHumidityState = function (accessory, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining humidity for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting humidity for [%s]...", accessory.displayName);
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getHumidityState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting humidity for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting humidity for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting humidity for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting humidity for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      
      if (body.length < 1) {
         callback('An error occurred while requesting humidity for your device');
         accessory.reachable = false;
         return;
      }
      
      let deviceId = accessory.context.deviceId;
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         
         let device = filteredResponse[0];
         
         if (device.deviceid === deviceId) {
            
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API.", accessory.displayName);
               callback("API reported that [%s] is not online", device.name);
               return;
            }
            
            let currentHumidity = device.params.currentHumidity;
            
            if (accessory.getService(Service.Thermostat)) {
               accessory.getService(Service.Thermostat)
               .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
            }
            if (accessory.getService(Service.HumiditySensor)) {
               accessory.getService(Service.Thermostat)
               .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
            }
            accessory.reachable = true;
            platform.log("API reported that [%s] humidity is [%s].", device.name, currentHumidity);
            callback(null, currentHumidity);
         }
         
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting humidity for your device');
      }
   });
};

eWeLink.prototype.getBlindPosition = function (accessory, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   let lastPosition = accessory.context.lastPosition;
   if (lastPosition === undefined) {
      lastPosition = 0;
   }
   
   platform.log("[%s] 'getCurrentPosition' is [%s].", accessory.displayName, lastPosition);
   callback(null, lastPosition);
};

eWeLink.prototype.getBlindMovementState = function (accessory, callback) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   if (!platform.webClient) {
      callback("this.webClient not yet ready while obtaining blind position for your device.");
      accessory.reachable = false;
      return;
   }
   
   platform.log("Requesting blind position for [%s]", accessory.displayName);
   
   platform.webClient.get('/api/user/device?' + platform.getArguments(platform.apiKey), function (err, res, body) {
      
      if (err) {
         if (res && [503].indexOf(parseInt(res.statusCode)) !== -1) {
            platform.log('Sonoff API 503 error. Will try again.');
            setTimeout(function () {
               platform.getHumidityState(accessory, callback);
            }, 1000);
         } else {
            platform.log("An error occurred while requesting blind position for [%s]. Error [%s].", accessory.displayName, err);
         }
         return;
      } else if (!body) {
         platform.log("An error occurred while requesting blind position for [%s]. Error [No data in response].", accessory.displayName);
         return;
      } else if (body.hasOwnProperty('error') && body.error != 0) {
         platform.log("An error occurred while requesting blind position for [%s]. Error [%s].", accessory.displayName, JSON.stringify(body));
         if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
            platform.relogin();
         }
         callback('An error occurred while requesting blind position for your device');
         return;
      }
      
      body = body.devicelist;
      
      let size = Object.keys(body)
      .length;
      if (body.length < 1) {
         callback('An error occurred while requesting blind position for your device');
         accessory.reachable = false;
         return;
      }
      let deviceId = accessory.context.deviceId;
      if (accessory.context.switches > 1) {
         deviceId = deviceId.replace("CH" + accessory.context.channel, "");
      }
      let filteredResponse = body.filter(device => (device.deviceid === deviceId));
      
      if (filteredResponse.length === 1) {
         let device = filteredResponse[0];
         if (device.deviceid === deviceId) {
            if (device.online !== true) {
               accessory.reachable = false;
               platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
               callback('API reported that [%s] is not online', device.name);
               return;
            }
            let switchCount = platform.getDeviceChannelCount(device);
            for (let i = 0; i !== switchCount; i++) {
               if (device.params.switches[i].switch === 'on') {
                  accessory.reachable = true;
                  platform.log("API reported that [%s CH-%s] is [on].", device.name, i);
               }
            }
            let blindState = platform.prepareBlindState(device.params.switches, accessory);
            platform.log("[%s] 'CurrentPositionState' is [%s].", accessory.displayName, blindState);
            // Handling error;
            if (blindState > 2) {
               blindState = 2;
               accessory.context.currentPositionState = 2;
               platform.prepareBlindFinalState(accessory);
               platform.log("Error with requesting [%s] position. Stopping.", accessory.displayName);
            }
            callback(null, blindState);
         }
      } else if (filteredResponse.length > 1) {
         // More than one device matches our Device ID. This should not happen.
         platform.log("Error - the response contained more than one device with ID [%s].", device.deviceid);
         platform.log(filteredResponse);
         callback("The response contained more than one device with ID " + device.deviceid);
      } else if (filteredResponse.length < 1) {
         // The device is no longer registered
         platform.log("Error - [%s] did not exist in the response. Verify the device is connected to your eWeLink account.", accessory.displayName);
         platform.removeAccessory(accessory);
      } else {
         callback('An error occurred while requesting blind position for your device');
      }
   });
};

eWeLink.prototype.getBlindTargetPosition = function (accessory, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   let currentTargetPosition = accessory.context.currentTargetPosition;
   platform.log("[%s] 'getTargetPosition' is [%s].", accessory.displayName, currentTargetPosition);
   callback(null, currentTargetPosition);
};

eWeLink.prototype.setPowerState = function (accessory, isOn, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   
   // actionChar can be:
   // X = single switch device              -> simple case just update the channel
   // 0 = multiple switch master device     -> slightly more complicated as we need to update all it's channels
   // 1 = multiple switch channel 0         -> most complicated as each update we
   // 2 = multiple switch channel 1         -> ...need to check to see if the other
   // 3 = multiple switch channel 2         -> ...channels are on or off and perhaps
   // 4 = multiple switch channel 3         -> ...update the master device
   
   let fulldeviceId = accessory.context.deviceId;                   // eg 10006253b8SW2       <- deviceId in Homebridge
   let deviceToUpdate = fulldeviceId.slice(0, -3);                  // eg 10006253b8          <- deviceId in eWeLink
   let actionChar = fulldeviceId.substr(-1);                        // ie X, 0, 1, 2, 3, 4    <- see above
   let targetState = isOn ? 'on' : 'off';                           // ie "on" or "off"
   
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   
   switch (actionChar) {
      case "X":
      payload.params.switch = targetState;
      break;
      case "0":
      currentDeviceState = platform.devicesInEwe.get(deviceToUpdate);
      payload.params.switches = currentDeviceState.params.switches;
      payload.params.switches[0].switch = targetState;
      payload.params.switches[1].switch = targetState;
      payload.params.switches[2].switch = targetState;
      payload.params.switches[3].switch = targetState;
      break;
      case "1":
      case "2":
      case "3":
      case "4":
      currentDeviceState = platform.devicesInEwe.get(deviceToUpdate);
      payload.params.switches = currentDeviceState.params.switches;
      payload.params.switches[parseInt(actionChar) - 1].switch = targetState;
      break;
   }
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + deviceToUpdate;
   payload.sequence = platform.getSequence();
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
   if (platform.debug) platform.log("[%s] has been turned [%s].", accessory.displayName, targetState);
};

eWeLink.prototype.setTemperatureState = function (accessory, value, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   let deviceId = accessory.context.deviceId;
   let deviceFromApi = platform.devicesInEwe.get(deviceId);
   platform.log("Setting [%s] temperature to [%s].", accessory.displayName, value);
   /*
   deviceFromApi.params.currentHumidity = value;
   if(accessory.getService(Service.Thermostat)) {
      accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentTemperature, value);
   } else if(accesory.getService(Service.TemperatureSensor)) {
      accessory.getService(Service.TemperatureSensor).setCharacteristic(Characteristic.CurrentTemperature, value);
   }
   */
   callback();
};

eWeLink.prototype.setHumidityState = function (accessory, value, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   let deviceId = accessory.context.deviceId;
   let deviceFromApi = platform.devicesInEwe.get(deviceId);
   
   platform.log("Setting [%s] humidity to [%s].", accessory.displayName, value);
   /*
   deviceFromApi.params.currentHumidity = value;
   if(accessory.getService(Service.Thermostat)) {
      accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
   } else if(accesory.getService(Service.HumiditySensor)) {
      accessory.getService(Service.HumiditySensor).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
   }
   */
   callback();
};

eWeLink.prototype.setFanState = function (accessory, isOn, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   let deviceId = accessory.context.deviceId;
   
   let targetState = 'off';
   
   if (isOn) {
      targetState = 'on';
   }
   
   platform.log("Setting [%s] fan to [%s].", accessory.displayName, targetState);
   
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   let deviceFromApi = platform.devicesInEwe.get(deviceId);
   payload.params.switches = deviceFromApi.params.switches;
   payload.params.switches[1].switch = targetState;
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + deviceId;
   
   payload.sequence = platform.getSequence();
   
   let string = JSON.stringify(payload);
   
   platform.sendWebSocketMessage(string, callback);
   
};

eWeLink.prototype.setFanSpeed = function (accessory, value, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   let deviceId = accessory.context.deviceId;
   
   platform.log("Setting [%s] fan speed to [%s].", accessory.displayName, value);
   
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   let deviceFromApi = platform.devicesInEwe.get(deviceId);
   payload.params.switches = deviceFromApi.params.switches;
   
   if (value < 33) {
      payload.params.switches[1].switch = 'off';
      payload.params.switches[2].switch = 'off';
      payload.params.switches[3].switch = 'off';
   } else if (value >= 33 && value < 66) {
      payload.params.switches[1].switch = 'on';
      payload.params.switches[2].switch = 'off';
      payload.params.switches[3].switch = 'off';
   } else if (value >= 66 && value < 99) {
      payload.params.switches[1].switch = 'on';
      payload.params.switches[2].switch = 'on';
      payload.params.switches[3].switch = 'off';
   } else if (value >= 99) {
      payload.params.switches[1].switch = 'on';
      payload.params.switches[2].switch = 'off';
      payload.params.switches[3].switch = 'on';
   }
   
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + deviceId;
   
   payload.sequence = platform.getSequence();
   
   let string = JSON.stringify(payload);
   
   platform.sendWebSocketMessage(string, callback);
};

eWeLink.prototype.setFanLightState = function (accessory, isOn, callback) {
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   let deviceId = accessory.context.deviceId;
   
   let targetState = 'off';
   
   if (isOn) {
      targetState = 'on';
   }
   
   platform.log("Setting [%s] fan light to [%s].", accessory.displayName, targetState);
   
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   let deviceFromApi = platform.devicesInEwe.get(deviceId);
   payload.params.switches = deviceFromApi.params.switches;
   payload.params.switches[0].switch = targetState;
   
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + deviceId;
   
   payload.sequence = platform.getSequence();
   
   let string = JSON.stringify(payload);
   platform.sendWebSocketMessage(string, callback);
   
};

eWeLink.prototype.setBlindTargetPosition = function (accessory, pos, callback) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   platform.log("Setting [%s] new target position from [%s] to [%s].", accessory.displayName, accessory.context.currentTargetPosition, pos, );
   
   let timestamp = Date.now();
   
   if (accessory.context.currentPositionState != 2) {
      
      var diffPosition = Math.abs(pos - accessory.context.currentTargetPosition);
      var actualPosition;
      var diffTime;
      var diff;
      
      if (diffPosition == 0) {
         actualPosition = pos;
         diffTime = 0;
         diff = 0;
      } else {
         if (accessory.context.currentPositionState == 1) {
            diffPosition = accessory.context.currentTargetPosition - pos;
            diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
         } else {
            diffPosition = pos - accessory.context.currentTargetPosition;
            diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
         }
         diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
         actualPosition = platform.prepareBlindPosition(accessory);
         
         // platform.log("diffPosition:", diffPosition);
         // platform.log("diffTime:", diffTime);
         // platform.log("actualPosition:", actualPosition);
         // platform.log("diff:", diff);
         
         if (diff > 0) {
            accessory.context.targetTimestamp += diffTime;
            // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
            accessory.context.currentTargetPosition = pos;
            platform.log("[%s] Blinds are moving. Current position: %s, new targuet: %s, adjusting target milliseconds: %s", accessory.displayName, actualPosition, pos, diffTime);
            callback();
            return false;
         }
         if (diff < 0) {
            platform.log("[%s] ==> Revert Blinds moving. Current pos: %s, new targuet: %s, new duration: %s", accessory.displayName, actualPosition, pos, Math.abs(diff));
            accessory.context.startTimestamp = timestamp;
            accessory.context.targetTimestamp = timestamp + Math.abs(diff);
            // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
            accessory.context.lastPosition = actualPosition;
            accessory.context.currentTargetPosition = pos;
            accessory.context.currentPositionState = accessory.context.currentPositionState == 0 ? 1 : 0;
            
            let payload = platform.prepareBlindPayload(accessory);
            let string = JSON.stringify(payload);
            
            if (platform.webSocketOpen) {
               platform.sendWebSocketMessage(string, function () {
                  return;
               });
               platform.log("[%s] Request sent for %s", accessory.displayName, accessory.context.currentPositionState == 1 ? "moving up" : "moving down");
               let service = accessory.getService(Service.WindowCovering);
               service.getCharacteristic(Characteristic.CurrentPosition)
               .updateValue(accessory.context.lastPosition);
               service.getCharacteristic(Characteristic.TargetPosition)
               .updateValue(accessory.context.currentTargetPosition);
               service.getCharacteristic(Characteristic.PositionState)
               .updateValue(accessory.context.currentPositionState);
            } else {
               platform.log('Socket was closed. It will reconnect automatically; please retry your command');
               callback('Socket was closed. It will reconnect automatically; please retry your command');
               return false;
            }
         }
         callback();
         return false;
      }
      callback();
      return false;
   }
   
   if (accessory.context.lastPosition == pos) {
      platform.log("[%s] Current position already matches target position. There is nothing to do.", accessory.displayName);
      callback();
      return true;
   }
   
   accessory.context.currentTargetPosition = pos;
   moveUp = (pos > accessory.context.lastPosition);
   
   var withoutmarginetimeUP;
   var withoutmarginetimeDOWN;
   var duration;
   withoutmarginetimeUP = accessory.context.durationUp - accessory.context.durationBMU;
   withoutmarginetimeDOWN = accessory.context.durationDown - accessory.context.durationBMD;
   
   if (moveUp) {
      if (accessory.context.lastPosition == 0) {
         duration = ((pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP) + accessory.context.durationBMU;
      } else {
         duration = (pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP;
      }
   } else {
      if (pos == 0) {
         duration = ((accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN) + accessory.context.durationBMD;
      } else {
         duration = (accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN;
      }
   }
   if (pos == 0 || pos == 100) duration += accessory.context.fullOverdrive;
   if (pos == 0 || pos == 100) platform.log("[%s] add overdive: %s", accessory.displayName, accessory.context.fullOverdrive);
   
   duration = Math.round(duration * 100) / 100;
   
   platform.log("[%s] %s, Duration: %s", accessory.displayName, moveUp ? "Moving up" : "Moving down", duration);
   
   accessory.context.startTimestamp = timestamp;
   accessory.context.targetTimestamp = timestamp + (duration * 1000);
   // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
   accessory.context.currentPositionState = (moveUp ? 0 : 1);
   accessory.getService(Service.WindowCovering)
   .setCharacteristic(Characteristic.PositionState, (moveUp ? 0 : 1));
   
   let payload = platform.prepareBlindPayload(accessory);
   let string = JSON.stringify(payload);
   
   if (platform.webSocketOpen) {
      
      setTimeout(function () {
         platform.sendWebSocketMessage(string, function () {
            return;
         });
         platform.log("[%s] Request sent for %s", accessory.displayName, moveUp ? "moving up" : "moving down");
         
         var interval = setInterval(function () {
            if (Date.now() >= accessory.context.targetTimestamp) {
               platform.prepareBlindFinalState(accessory);
               clearInterval(interval);
               return true;
            }
         }, 100);
         callback();
      }, 1);
   } else {
      platform.log('Socket was closed. It will reconnect automatically; please retry your command');
      callback('Socket was closed. It will reconnect automatically; please retry your command');
      return false;
   }
};

eWeLink.prototype.prepareBlindState = function (switches, accessory) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   
   // platform.log("Switches: %s", switches);
   var switch0 = 0;
   if (switches[accessory.context.switchUp].switch === 'on') {
      switch0 = 1;
   }
   
   var switch1 = 0;
   if (switches[accessory.context.switchDown].switch === 'on') {
      switch1 = 1;
   }
   
   let sum = (switch0 * 2) + switch1;
   
   // this.log("Sum: ", sum);
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => Error
   
   const MAPPING = {
      0: 2,
      1: 1,
      2: 0,
      3: 3
   };
   // this.log("Sum: %s => Blind State: %s", sum, MAPPING[sum]);
   return MAPPING[sum];
};

eWeLink.prototype.prepareBlindFinalState = function (accessory) {
   
   let platform = this;
   
   if (!platform.log) {
      return;
   }
   accessory.context.currentPositionState = 2;
   let payload = platform.prepareBlindPayload(accessory);
   let string = JSON.stringify(payload);
   
   if (platform.webSocketOpen) {
      
      setTimeout(function () {
         platform.sendWebSocketMessage(string, function () {
            return;
         });
         platform.log("[%s] Request sent to stop moving", accessory.displayName);
         accessory.context.currentPositionState = 2;
         
         let currentTargetPosition = accessory.context.currentTargetPosition;
         accessory.context.lastPosition = currentTargetPosition;
         let service = accessory.getService(Service.WindowCovering);
         // Using updateValue to avoid loop
         service.getCharacteristic(Characteristic.CurrentPosition)
         .updateValue(currentTargetPosition);
         service.getCharacteristic(Characteristic.TargetPosition)
         .updateValue(currentTargetPosition);
         service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
         
         platform.log("[%s] Successfully moved to target position: %s", accessory.displayName, currentTargetPosition);
         return true;
         // TODO Here we need to wait for the response to the socket
      }, 1);
      
   } else {
      platform.log('Socket was closed. It will reconnect automatically; please retry your command');
      return false;
   }
};

eWeLink.prototype.prepareBlindPayload = function (accessory) {
   
   let platform = this;
   if (!platform.log) {
      return;
   }
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {};
   let deviceFromApi = platform.devicesInEwe.get(accessory.context.deviceId);
   
   payload.params.switches = deviceFromApi.params.switches;
   
   // [0,0] = 0 => 2 Stopped
   // [0,1] = 1 => 1 Moving down
   // [1,0] = 2 => 0 Moving up
   // [1,1] = 3 => should not happen...
   
   var switch0 = 'off';
   var switch1 = 'off';
   
   let state = accessory.context.currentPositionState;
   
   switch (state) {
      case 2:
      switch0 = 'off';
      switch1 = 'off';
      break;
      case 1:
      switch0 = 'off';
      switch1 = 'on';
      break;
      case 0:
      switch0 = 'on';
      switch1 = 'off';
      break;
      default:
      platform.log('[%s] PositionState type error !', accessory.displayName);
      break;
   }
   
   payload.params.switches[accessory.context.switchUp].switch = switch0;
   payload.params.switches[accessory.context.switchDown].switch = switch1;
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + accessory.context.deviceId;
   payload.sequence = platform.getSequence();
   // platform.log("Payload genretad:", JSON.stringify(payload))
   return payload;
};

eWeLink.prototype.prepareBlindPosition = function (accessory) {
   let timestamp = Date.now();
   if (accessory.context.currentPositionState == 1) {
      return Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
   } else if (accessory.context.currentPositionState == 0) {
      return Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
   } else {
      return accessory.context.lastPosition;
   }
};

eWeLink.prototype.prepareBlindSwitchConfig = function (accessory) {
   // This function should not be called from configureAccessory() because we need to be connected to the web socket.
   let platform = this;
   if (!platform.log) {
      return;
   }
   let payload = {};
   payload.action = 'update';
   payload.userAgent = 'app';
   payload.params = {
      "lock": 0,
      "zyx_clear_timers": false,
      "configure": [{
         "startup": "off",
         "outlet": 0
      }, {
         "startup": "off",
         "outlet": 1
      }, {
         "startup": "off",
         "outlet": 2
      }, {
         "startup": "off",
         "outlet": 3
      }],
      "pulses": [{
         "pulse": "off",
         "width": 1000,
         "outlet": 0
      }, {
         "pulse": "off",
         "width": 1000,
         "outlet": 1
      }, {
         "pulse": "off",
         "width": 1000,
         "outlet": 2
      }, {
         "pulse": "off",
         "width": 1000,
         "outlet": 3
      }],
      "switches": [{
         "switch": "off",
         "outlet": 0
      }, {
         "switch": "off",
         "outlet": 1
      }, {
         "switch": "off",
         "outlet": 2
      }, {
         "switch": "off",
         "outlet": 3
      }]
   };
   payload.apikey = '' + accessory.context.apiKey;
   payload.deviceid = '' + accessory.context.deviceId;
   payload.sequence = platform.getSequence();
   
   let string = JSON.stringify(payload);
   
   // Delaying execution to be sure Socket is open
   platform.log("[%s] Waiting 5 sec before sending init config request...", accessory.displayName);
   
   setTimeout(function () {
      if (platform.webSocketOpen) {
         
         setTimeout(function () {
            platform.wsc.send(string);
            platform.log("[%s] Request sent to configure switches", accessory.displayName);
            return true;
            // TODO Here we need to wait for the response to the socket
         }, 1);
         
      } else {
         platform.log("[%s] Socket was closed. Retrying is 5 sec...", accessory.displayName);
         setTimeout(function () {
            platform.prepareBlindSwitchConfig(accessory);
            platform.log("[%s] Request sent to configure switches", accessory.displayName);
            return false;
            // TODO Here we need to wait for the response to the socket
         }, 5000);
      }
   }, 5000);
};

eWeLink.prototype.getSequence = function () {
   let time_stamp = new Date() / 1000;
   this.sequence = Math.floor(time_stamp * 1000);
   return this.sequence;
};

eWeLink.prototype.sendWebSocketMessage = function (string, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!platform.hasOwnProperty('delaySend')) {
      platform.delaySend = 0;
   }
   const delayOffset = 280;
   
   let sendOperation = function (string) {
      if (!platform.webSocketOpen) {
         // socket not open, retry later
         setTimeout(function () {
            sendOperation(string);
         }, delayOffset);
         return;
      }
      
      if (platform.wsc) {
         platform.wsc.send(string);
         if (platform.debug) platform.log("WS message sent [%s].", string);
         callback();
      }
      
      if (platform.delaySend <= 0) {
         platform.delaySend = 0;
      } else {
         platform.delaySend -= delayOffset;
      }
   };
   
   if (!platform.webSocketOpen) {
      platform.log('Socket was closed. It will reconnect automatically.');
      
      let interval;
      let waitToSend = function (string) {
         if (platform.webSocketOpen) {
            clearInterval(interval);
            sendOperation(string);
         }
      };
      interval = setInterval(waitToSend, 750, string);
   } else {
      setTimeout(sendOperation, platform.delaySend, string);
      platform.delaySend += delayOffset;
   }
};

eWeLink.prototype.getSignature = function (string) {
   //let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
   //let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
   //let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
   let decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; //decrypt(appSecret);
   return crypto.createHmac('sha256', decryptedAppSecret)
   .update(string)
   .digest('base64');
};

eWeLink.prototype.login = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   if (!platform.config.username || !platform.config.password || !platform.config.countryCode) {
      platform.log("Please check you have set your username, password and country code in the Homebridge config.");
      callback();
      return;
   }
   
   var data = {};
   if (platform.emailLogin) {
      data.email = platform.config.username;
   } else {
      data.phoneNumber = platform.config.username;
   }
   data.password = platform.config.password;
   data.version = '8';
   data.ts = '' + Math.floor(new Date()
   .getTime() / 1000);
   data.nonce = '' + nonce();
   data.appid = platform.appid;
   
   let json = JSON.stringify(data);
   if (platform.debug) platform.log("Sending login request with credentials: [%s]", json);
   
   let sign = platform.getSignature(json);
   if (platform.debug) platform.log("Login signature [%s]", sign);
   let webClient = request.createClient('https://' + platform.apiHost);
   webClient.headers['Authorization'] = 'Sign ' + sign;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.post('/api/user/login', data, function (err, res, body) {
      if (err) {
         platform.log("An error occurred while logging in. [%s]", err);
         callback();
         return;
      }
      
      // If we receive 301 error, switch to new region and try again
      if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
         let idx = platform.apiHost.indexOf('-');
         if (idx == -1) {
            platform.log("Received new region [%s]. However we cannot construct the new API host url.", body.region);
            callback();
            return;
         }
         let newApiHost = body.region + platform.apiHost.substring(idx);
         if (platform.apiHost != newApiHost) {
            platform.log("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
            platform.apiHost = newApiHost;
            platform.login(callback);
            return;
         }
      }
      
      if (!body.at) {
         let response = JSON.stringify(body);
         platform.log("Server did not response with an authentication token. Response was [%s].", response);
         callback();
         return;
      }
      
      if (platform.debug) platform.log('Received authToken [%s] and apiKey.', body.at, body.user.apikey);
      platform.authenticationToken = body.at;
      platform.apiKey = body.user.apikey;
      platform.webClient = request.createClient('https://' + platform.apiHost);
      platform.webClient.headers['Authorization'] = 'Bearer ' + body.at;
      
      platform.getWebSocketHost(function () {
         callback(body.at);
      }.bind(this));
   }.bind(this));
};

eWeLink.prototype.getRegion = function (countryCode, callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   var data = {};
   data.country_code = countryCode;
   data.version = '8';
   data.ts = '' + Math.floor(new Date()
   .getTime() / 1000);
   data.nonce = '' + nonce();
   data.appid = platform.appid;
   
   let query = querystring.stringify(data);
   if (platform.debug) platform.log("Info: getRegion query [%s]", query);
   
   let dataToSign = [];
   Object.keys(data)
   .forEach(function (key) {
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
   })
   .join('&');
   
   let sign = platform.getSignature(dataToSign);
   if (platform.debug) platform.log("Info: getRegion signature [%s]", sign);
   
   let webClient = request.createClient('https://api.coolkit.cc:8080');
   webClient.headers['Authorization'] = 'Sign ' + sign;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.get('/api/user/region?' + query, function (err, res, body) {
      if (err) {
         platform.log("An error occurred while getting region [%s]", err);
         callback();
         return;
      }
      
      if (!body.region) {
         let response = JSON.stringify(body);
         platform.log("Server did not response with a region [%s]", response);
         callback();
         return;
      }
      
      let idx = platform.apiHost.indexOf('-');
      if (idx == -1) {
         platform.log("Received region [%s]. However we cannot construct the new API host url.", body.region);
         callback();
         return;
      }
      let newApiHost = body.region + platform.apiHost.substring(idx);
      if (platform.apiHost != newApiHost) {
         platform.log("Received region [%s], updating API host to [%s].", body.region, newApiHost);
         platform.apiHost = newApiHost;
      }
      callback(body.region);
   }.bind(this));
};

eWeLink.prototype.getWebSocketHost = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   var data = {};
   data.accept = 'mqtt,ws';
   data.version = '8';
   data.ts = '' + Math.floor(new Date()
   .getTime() / 1000);
   data.nonce = '' + nonce();
   data.appid = platform.appid;
   
   let webClient = request.createClient('https://' + platform.apiHost.replace('-api', '-disp'));
   webClient.headers['Authorization'] = 'Bearer ' + platform.authenticationToken;
   webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
   webClient.post('/dispatch/app', data, function (err, res, body) {
      if (err) {
         platform.log("An error occurred while getting websocket host [%s]", err);
         callback();
         return;
      }
      
      if (!body.domain) {
         let response = JSON.stringify(body);
         platform.log("Server did not response with a websocket host [%s]", response);
         callback();
         return;
      }
      
      if (platform.debug) platform.log('Web socket host received [%s].', body.domain);
      platform.wsHost = body.domain;
      if (platform.wsc) {
         platform.wsc.url = 'wss://' + body.domain + ':8080/api/ws';
      }
      callback(body.domain);
   }.bind(this));
};

eWeLink.prototype.relogin = function (callback) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   platform.login(function () {
      if (platform.webSocketOpen) {
         platform.wsc.instance.terminate();
         platform.wsc.onclose();
         platform.wsc.reconnect();
      }
      callback && callback();
   });
};

eWeLink.prototype.getDeviceTypeByUiid = function (uiid) {
   const MAPPING = {
      1: "SOCKET",
      2: "SOCKET_2",
      3: "SOCKET_3",
      4: "SOCKET_4",
      5: "SOCKET_POWER",
      6: "SWITCH",
      7: "SWITCH_2",
      8: "SWITCH_3",
      9: "SWITCH_4",
      10: "OSPF",
      11: "CURTAIN",
      12: "EW-RE",
      13: "FIREPLACE",
      14: "SWITCH_CHANGE",
      15: "THERMOSTAT",
      16: "COLD_WARM_LED",
      17: "THREE_GEAR_FAN",
      18: "SENSORS_CENTER",
      19: "HUMIDIFIER",
      22: "RGB_BALL_LIGHT",
      23: "NEST_THERMOSTAT",
      24: "GSM_SOCKET",
      25: "AROMATHERAPY",
      26: "BJ_THERMOSTAT",
      27: "GSM_UNLIMIT_SOCKET",
      28: "RF_BRIDGE",
      29: "GSM_SOCKET_2",
      30: "GSM_SOCKET_3",
      31: "GSM_SOCKET_4",
      32: "POWER_DETECTION_SOCKET",
      33: "LIGHT_BELT",
      34: "FAN_LIGHT",
      35: "EZVIZ_CAMERA",
      36: "SINGLE_CHANNEL_DIMMER_SWITCH",
      38: "HOME_KIT_BRIDGE",
      40: "FUJIN_OPS",
      41: "CUN_YOU_DOOR",
      42: "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT",
      43: "",
      44: "",
      45: "DOWN_CEILING_LIGHT",
      46: "AIR_CLEANER",
      49: "MACHINE_BED",
      51: "COLD_WARM_DESK_LIGHT",
      52: "DOUBLE_COLOR_DEMO_LIGHT",
      53: "ELECTRIC_FAN_WITH_LAMP",
      55: "SWEEPING_ROBOT",
      56: "RGB_BALL_LIGHT_4",
      57: "MONOCHROMATIC_BALL_LIGHT",
      59: "MEARICAMERA",
      77: "MICRO",
      1001: "BLADELESS_FAN",
      1002: "NEW_HUMIDIFIER",
      1003: "WARM_AIR_BLOWER"
   };
   return MAPPING[uiid] || "";
};

eWeLink.prototype.getDeviceChannelCountByType = function (deviceType) {
   const DEVICE_CHANNEL_LENGTH = {
      SOCKET: 1,
      SWITCH_CHANGE: 1,
      GSM_UNLIMIT_SOCKET: 1,
      SWITCH: 1,
      THERMOSTAT: 1,
      SOCKET_POWER: 1,
      GSM_SOCKET: 1,
      POWER_DETECTION_SOCKET: 1,
      MICRO: 4,
      SOCKET_2: 2,
      GSM_SOCKET_2: 2,
      SWITCH_2: 2,
      SOCKET_3: 3,
      GSM_SOCKET_3: 3,
      SWITCH_3: 3,
      SOCKET_4: 4,
      GSM_SOCKET_4: 4,
      SWITCH_4: 4,
      CUN_YOU_DOOR: 4,
      FAN_LIGHT: 4
   };
   return DEVICE_CHANNEL_LENGTH[deviceType] || 0;
};

eWeLink.prototype.getDeviceChannelCount = function (device) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   let deviceType = platform.getDeviceTypeByUiid(device.uiid);
   let channels = platform.getDeviceChannelCountByType(deviceType);
   return channels;
};

eWeLink.prototype.getArguments = function (apiKey) {
   let platform = this;
   if (!platform.log) {
      return;
   }
   let args = {};
   args.apiKey = apiKey;
   args.version = '8';
   args.ts = '' + Math.floor(new Date()
   .getTime() / 1000);
   args.nonce = '' + nonce();
   args.appid = platform.appid;
   return querystring.stringify(args);
};

/* WEB SOCKET STUFF */

function WebSocketClient() {
   this.number = 0; // Message number
   this.autoReconnectInterval = 5 * 1000; // ms
   this.pendingReconnect = false;
}

WebSocketClient.prototype.open = function (url) {
   this.url = url;
   this.instance = new WebSocket(this.url);
   this.instance.on('open', () => {
      this.onopen();
   });
   
   this.instance.on('message', (data, flags) => {
      this.number++;
      this.onmessage(data, flags, this.number);
   });
   
   this.instance.on('close', (e) => {
      switch (e) {
         case 1005: // CLOSE_NORMAL
         // console.log("WebSocket: closed");
         break;
         default: // Abnormal closure
         this.reconnect(e);
         break;
      }
      this.onclose(e);
   });
   this.instance.on('error', (e) => {
      switch (e.code) {
         case 'ECONNREFUSED':
         this.reconnect(e);
         break;
         default:
         this.onerror(e);
         break;
      }
   });
};
WebSocketClient.prototype.send = function (data, option) {
   try {
      this.instance.send(data, option);
   } catch (e) {
      this.instance.emit('error', e);
   }
};
WebSocketClient.prototype.reconnect = function (e) {
   // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);
   
   if (this.pendingReconnect) return;
   this.pendingReconnect = true;
   
   this.instance.removeAllListeners();
   
   let platform = this;
   setTimeout(function () {
      platform.pendingReconnect = false;
      console.log("WebSocketClient: Reconnecting...");
      platform.open(platform.url);
   }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function (e) {
   // console.log("WebSocketClient: open", arguments);
};
WebSocketClient.prototype.onmessage = function (data, flags, number) {
   // console.log("WebSocketClient: message", arguments);
};
WebSocketClient.prototype.onerror = function (e) {
   console.log("WebSocketClient: error", arguments);
};
WebSocketClient.prototype.onclose = function (e) {
   // console.log("WebSocketClient: closed", arguments);
};
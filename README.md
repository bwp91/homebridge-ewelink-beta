# homebridge-ewelink-sonoff
There seems to be a variety of Homebridge plugins for eWeLink/Sonoff devices. My aim for this package is to bring together the best from all the different ones. I am constantly tinkering with the code, please feel free to post issues or pull requests.

This project was forked and based on the work of [homebridge-ewelink-max](https://github.com/howanghk/homebridge-ewelink).

Thanks :)
## Installation
Please see the [installation](https://github.com/thepotterfamily/homebridge-ewelink-sonoff/wiki/Installation) wiki page for guidance.

If you're feeling brave, I normally have a beta version with changes that needs testing.
#### Beta Version (v1.6.1-3)
To install the beta version simply run this command in terminal (no need to uninstall any previous version):
```bash
sudo npm i homebridge-ewelink-sonoff@next -g
```
#### Current Version (v1.6.0)
To revert back to the current version simply run this command in terminal (no need to uninstall the beta version):
```bash
sudo npm i homebridge-ewelink-sonoff@latest -g
```

## Supported Devices
#### 🟢 Switches
The plugin **should** work with Sonoff switches (single and multi-channel).
- **Supported:** BASIC, MINI, 4CH
#### 🟢 Light Bulbs
The plugin **should** work with Sonoff bulbs and LED strips, giving you control of the brightness and colour (🇬🇧!) of your device.
- **Supported:** B1, L1
#### 🟢 Light Switches
The plugin **should** work with Sonoff light and dimmer switches, and will be exposed as lights in Homebridge.
- **Supported:** T1-1C, T1-2C, T1-3C, TX-1C, TX-2C, TX-3C, KING-M4, SLAMPHER, D1
#### 🟢 Outlets
The plugin **should** work with Sonoff outlets. Unfortunately there is no native method in HomeKit to show power readings.
- **Supported:** POW
#### 🟢 RF Bridges
The plugin **should** work with the Sonoff Bridge, at the moment exposing motion sensors that will detect motion and notify Homebridge/HomeKit. Other devices connected to the RF bridge might cause issues.
- **Supported:** RF_BRIDGE
#### 🟢 Thermostats
The plugin **should** work with Sonoff Thermostat devices, exposing a temperature sensor, a humidity sensor (if the device supports it) and a switch in Homebridge for the connected device.
- **Supported:** TH10, TH16
#### 🟠 Fans
The plugin **might** work with Sonoff Fan devices. I need a kind person with the a device to assist!
- **Needs Testing:** iFan02, iFan03
#### 🟠 Custom Devices
> By custom devices I mean using a generic Sonoff device to simulate a specific type of accessory that is HomeKit supported (e.g. blinds and garage doors).
- **Needs Testing:** Blinds (with a two-channel device)
- **Needs Testing:** Garage Doors (with a one-channel device)
## About
#### My future plans/ideas
- Support for more devices is always a good thing.
#### Issues/Pull Requests
Please feel free to submit - the more the merrier!
#### Credits
- @gbro115 → @MrTomAsh → @howanghk - the line of succession of this plugin that I forked from. Otherwise this package wouldn't exist!
- @ozzyobr - for his continued support throughout, e.g. his work with colour conversion, his help with supporting the L1 LED strip.
- @attarawnneh - for his hours of patience whilst we trialled and errored with the RF Bridge - we got there I hope!
- @gmeiburg88 - for trusting my control of his baby's dimmer lamp to enable support for D1... and the heater too!
- @victorcooper - for allowing me to turn his room into a disco with lights and colours of his B1))
- @minws13 - for giving me remote access to his aquarium thermostat to add support for these devices.

Thank you to all 😃.

<span align="center">
    
# homebridge-ewelink-beta
    
[![Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=discord)](https://discord.com/channels/432663330281226270/742733745743855627)
[![npm](https://img.shields.io/npm/dt/homebridge-ewelink-beta)](https://www.npmjs.com/package/homebridge-ewelink)   
[![npm](https://img.shields.io/npm/v/homebridge-ewelink?label=release)](https://www.npmjs.com/package/homebridge-ewelink)
[![npm](https://img.shields.io/npm/v/homebridge-ewelink-beta?label=beta)](https://www.npmjs.com/package/homebridge-ewelink-beta)

</span>


This is a **beta** channel for my [homebridge-ewelink](https://github.com/bwp91/homebridge-ewelink) package. So if you are looking for a more stable version then I would recommend installing [homebridge-ewelink](https://github.com/bwp91/homebridge-ewelink) instead.

This package is for new features and code changes that need testing before they are rolled out into the main [homebridge-ewelink](https://github.com/bwp91/homebridge-ewelink) package.

Being a beta package, it could very well cause errors to the point of your Homebridge instance being unable to start.

To switch between the different versions you can use Homebridge Config UI X to uninstall and reinstall the other. The configuration is exactly the same for both. Or, simply run these commands in the Homebridge terminal and then restart Homebridge. I keep the version numbers synchronised so if both packages have the same version then they are identical at that point in time.

> Please note these commands will only work in Homebridge. They will **not** work in HOOBS.

#### Beta Version (homebridge-ewelink-beta)
To change to the beta version:
```bash
$ sudo npm uninstall homebridge-ewelink -g
$ sudo npm install homebridge-ewelink-beta -g
```
#### Stable Version ([homebridge-ewelink](https://github.com/bwp91/homebridge-ewelink))
To change to the stable version:
```bash
$ sudo npm uninstall homebridge-ewelink-beta -g
$ sudo npm install homebridge-ewelink -g
```

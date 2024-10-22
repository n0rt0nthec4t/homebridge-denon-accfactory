// homebridge-denon-accfactory
//
// reference for details:
// https://github.com/subutux/denonavr/blob/master/CommandEndpoints.txt
// https://github.com/scarface-4711/denonavr
// https://www.heimkinoraum.de/upload/files/product/IP_Protocol_AVR-Xx100.pdf
//
// Code version 21/10/2024
// Mark Hulskamp
'use strict';

// Import our modules
import DenonAccfactory from './denon.js';
import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-denon-accfactory';
HomeKitDevice.PLATFORM_NAME = 'DenonAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

export default (api) => {
  // Register our platform with HomeBridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, DenonAccfactory);
};

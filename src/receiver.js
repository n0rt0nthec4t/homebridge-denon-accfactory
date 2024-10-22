// HomeKit AV Receiver
// Part of homebridge-denon-accfactory
//
// Code version 21/10/2024
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

export default class AVReceiver extends HomeKitDevice {
  static RemoteCommand = {
    NEXT_TRACK: 'NS9D',
    PREVIOUS_TRACK: 'NS9E',
    ARROW_UP: 'MNCUP',
    ARROW_DOWN: 'MNCDN',
    ARROW_LEFT: 'MNCLT',
    ARROW_RIGHT: 'MNCRT',
    SELECT: 'MNENT',
    BACK: 'MNRTN',
    EXIT: 'MNRTN',
    PLAY_PAUSE: 'NS94',
    INFORMATION: 'MNINF',
    SETTINGS: 'MNMEN ON',
  };

  // Internal data only for this class
  #remoteCommands = [];
  #amplifierServices = [];

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);

    // Define some extra remote commands that aren't in the HAP spec
    this.hap.Characteristic.RemoteKey.SETTINGS = 101;
    this.hap.Characteristic.RemoteKey.PLAY = 102;
    this.hap.Characteristic.RemoteKey.PAUSE = 102;
    this.hap.Characteristic.RemoteKey.HOME = 103;

    // Setup our internal mapping of HomeKit define remote keys, to Denon/Mirantz
    this.#remoteCommands = {
      [this.hap.Characteristic.RemoteKey.NEXT_TRACK]: AVReceiver.RemoteCommand.NEXT_TRACK,
      [this.hap.Characteristic.RemoteKey.PREVIOUS_TRACK]: AVReceiver.RemoteCommand.PREVIOUS_TRACK,
      [this.hap.Characteristic.RemoteKey.ARROW_UP]: AVReceiver.RemoteCommand.ARROW_UP,
      [this.hap.Characteristic.RemoteKey.ARROW_DOWN]: AVReceiver.RemoteCommand.ARROW_DOWN,
      [this.hap.Characteristic.RemoteKey.ARROW_LEFT]: AVReceiver.RemoteCommand.ARROW_LEFT,
      [this.hap.Characteristic.RemoteKey.ARROW_RIGHT]: AVReceiver.RemoteCommand.ARROW_RIGHT,
      [this.hap.Characteristic.RemoteKey.SELECT]: AVReceiver.RemoteCommand.SETTINGS,
      [this.hap.Characteristic.RemoteKey.BACK]: AVReceiver.RemoteCommand.BACK,
      [this.hap.Characteristic.RemoteKey.EXIT]: AVReceiver.RemoteCommand.EXIT,
      [this.hap.Characteristic.RemoteKey.PLAY_PAUSE]: AVReceiver.RemoteCommand.PLAY_PAUSE,
      [this.hap.Characteristic.RemoteKey.INFORMATION]: AVReceiver.RemoteCommand.INFORMATION,
      [this.hap.Characteristic.RemoteKey.SETTINGS]: AVReceiver.RemoteCommand.SETTINGS,
    };
  }

  // Class functions
  addServices() {
    let postSetupDetails = [];

    this.deviceData.zones.forEach((zone, index) => {
      // Setup the "television" service if not already present on the accessory
      let tempService = this.accessory.getServiceById(this.hap.Service.Television, index + 1);
      if (tempService === undefined) {
        tempService = this.accessory.addService(this.hap.Service.Television, '', index + 1);
      }
      tempService.setPrimaryService();

      // Set defaults for characteristics
      tempService.setCharacteristic(this.hap.Characteristic.ConfiguredName, zone.name);
      tempService.setCharacteristic(
        this.hap.Characteristic.SleepDiscoveryMode,
        this.hap.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
      );
      tempService.setCharacteristic(this.hap.Characteristic.ClosedCaptions, this.hap.Characteristic.ClosedCaptions.DISABLED);

      // Setup callbacks for characteristics

      this.#amplifierServices.push(this.tempService);

      postSetupDetails.push('Zone "' + zone.name + '"');
    });

    return postSetupDetails;
  }

  setZonePower(zone, value, callback) {
    this.AMPServices[zone - 1].updateCharacteristic(HAP.Characteristic.Active, value);
    this.set({ command: (zone == 1 ? 'ZM' : 'Z' + zone) + (value == HAP.Characteristic.Active.ACTIVE ? 'ON' : 'OFF') });

    this.cachedOptions.zones = structuredClone(this.deviceData.zones); // Deep copy
    this.cachedOptions.zones[zone - 1].power = value == HAP.Characteristic.Active.ACTIVE ? true : false;
  }

  getZonePower(zone, callback) {
    if (typeof callback === 'function')
      callback(null, this.deviceData.zones[zone - 1].power == true ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE); // do callback if defined
    return this.deviceData.zones[zone - 1].power;
  }

  setZoneInput(zone, value, callback) {
    let input = this.deviceData.inputs.find(({ uri }) => this.#crc32(uri) == value);
    if (typeof input == 'object') {
      this.AMPServices[zone - 1].updateCharacteristic(HAP.Characteristic.ActiveIdentifier, value);

      if (input.uri.startsWith('TUNER') == true) {
        // Set input to a tuner
        this.set({ command: zone == 1 ? 'SITUNER' : 'Z' + zone + 'TUNER' });
        this.set({ command: 'TMAN' + input.uri.substring(5, input.uri.length) });
      }
      if (input.uri.startsWith('PRESET') == true) {
        // Set input to a tuner preset
        this.set({ command: zone == 1 ? 'SITUNER' : 'Z' + zone + 'TUNER' });
        this.set({ command: 'TMAN' + input.title.split(' ')[0] }); // AM/FM/DAB
        this.set({ command: 'TPAN' + input.uri.substring(6, 8) });
      }
      if (input.uri.startsWith('TUNER') == false && input.uri.startsWith('PRESET') == false) {
        // Set to another input which isn't a tuner or preset
        this.set({ command: (zone == 1 ? 'SI' : 'Z' + zone) + input.uri });
      }
      this.cachedOptions.zones = structuredClone(this.deviceData.zones); // Deep copy
      this.cachedOptions.zones[zone - 1].input = input.uri;
      this.cachedOptions.zones[zone - 1].source = typeof preset == 'object' ? preset.uri : '';
      this.cachedOptions.zones[zone - 1].label = '';
    }
  }

  getZoneInput(zone, callback) {
    let inputService = this.AMPInputs.find(
      (inputService) =>
        inputService.getCharacteristic(HAP.Characteristic.Identifier).value === this.#crc32(this.deviceData.zones[zone - 1].input),
    );
    if (typeof inputService == 'object') {
      let activeIdentifier = inputService.getCharacteristic(HAP.Characteristic.Identifier).value;

      if (this.deviceData.zones[zone - 1].input.startsWith('TUNER') == true && this.deviceData.zones[zone - 1].source != '') {
        let inputService = this.AMPInputs.find(
          (inputService) =>
            inputService.getCharacteristic(HAP.Characteristic.Identifier).value === this.#crc32(this.deviceData.zones[zone - 1].source),
        );
        if (typeof inputService == 'object') {
          // Preset input is active on the tuner
          activeIdentifier = inputService.getCharacteristic(HAP.Characteristic.Identifier).value;
        }
      }
    }
    return activeIdentifier;
  }

  setZoneVolume(zone, value, callback) {
    if (this.speakerServices[zone - 1].getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
      this.set({ command: (zone == 1 ? 'MV' : 'Z' + zone) + (value == HAP.Characteristic.VolumeSelector.INCREMENT ? 'UP' : 'DOWN') });
    }
  }

  setZoneMute(zone, value, callback) {
    if (this.speakerServices[zone - 1].getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
      this.set({ 'command:': (zone == 1 ? 'MU' : 'Z' + zone + 'MU') + (value == true ? 'ON' : 'OFF') });
    }
  }

  accessSettings(value, callback) {
    if (value == HAP.Characteristic.PowerModeSelection.SHOW) {
      this.sendRemoteKey(HAP.Characteristic.RemoteKey.SETTINGS, null);
    }
  }

  sendRemoteKey(value, callback) {
    let index = REMOTE_COMMANDS.findIndex(({ id }) => id === value);
    if (index != -1 && REMOTE_COMMANDS[index].command != '') {
      this.set({ command: REMOTE_COMMANDS[index].command });
    }
  }

  updateHomeKitServices(updatedDeviceData) {
    // Insert any cached parameters we have stored.
    Object.entries(this.cachedOptions).forEach(([key, value]) => {
      if (
        JSON.stringify(updatedDeviceData[key]) == JSON.stringify(this.deviceData[key]) &&
        JSON.stringify(updatedDeviceData[key]) != JSON.stringify(value)
      ) {
        // Since the new data from the device matches the existing device data, use value from cache
        updatedDeviceData[key] = value;
      } else if (JSON.stringify(updatedDeviceData[key]) != JSON.stringify(this.deviceData[key])) {
        // New data for this key is different than our internally stored data, so we'll assume a change was triggered on external system
        delete this.cachedOptions[key];
      } else if (
        JSON.stringify(value) == JSON.stringify(updatedDeviceData[key]) &&
        JSON.stringify(value) == JSON.stringify(this.deviceData[key])
      ) {
        // Our cached value now matches the incoming device data, so remove from cache
        delete this.cachedOptions[key];
      }
    });

    // Update zone(s) to indicate which input is active on that zone
    updatedDeviceData.zones.forEach((zone, index) => {
      if (zone.power != this.deviceData.zones[index].power) {
        if (zone.power == true) {
          // Zone is being powered on. If we have any cached data that needs sending, do so below
          // <---- TODO
        }

        outputLogging(
          ACCESSORYNAME,
          true,
          "Zone '%s' on '%s' was turned '%s'",
          zone.name,
          this.deviceData.description,
          zone.power == true ? 'on' : 'off',
        );
      }

      if (typeof this.AMPServices[index] == 'object') {
        this.AMPServices[index].updateCharacteristic(
          HAP.Characteristic.Active,
          zone.power == true ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE,
        );

        // Update active input for this zone. We still do this even if powered off to reflect in HomeKit
        let inputService = this.AMPInputs.find(
          (inputService) => inputService.getCharacteristic(HAP.Characteristic.Identifier).value === this.getZoneInput(index + 1, null),
        );
        if (typeof inputService == 'object') {
          this.AMPServices[index].updateCharacteristic(
            HAP.Characteristic.ActiveIdentifier,
            inputService.getCharacteristic(HAP.Characteristic.Identifier).value,
          );

          if (zone.power == true && zone.input != this.deviceData.zones[index].input) {
            // If device is powered on, log which input we changed to
            outputLogging(
              ACCESSORYNAME,
              true,
              "Input for Zone '%s' on '%s' was switched to '%s'",
              zone.name,
              this.deviceData.description,
              inputService.getCharacteristic(HAP.Characteristic.ConfiguredName).value,
            );
          }
        }
      }

      if (typeof this.speakerServices[index] == 'object') {
        this.speakerServices[index].updateCharacteristic(
          HAP.Characteristic.Active,
          zone.power == true ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE,
        );
        this.speakerServices[index].updateCharacteristic(HAP.Characteristic.Volume, zone.volume);
        this.speakerServices[index].updateCharacteristic(HAP.Characteristic.Mute, zone.mute);
      }
    });

    // Update input names and which are hidden/shown.
    updatedDeviceData.inputs.forEach((input) => {
      let inputService = this.AMPInputs.find(
        (inputService) => inputService.getCharacteristic(HAP.Characteristic.Identifier).value === this.#crc32(input.uri),
      );
      if (typeof inputService == 'object') {
        inputService.updateCharacteristic(HAP.Characteristic.ConfiguredName, input.label);
        inputService.updateCharacteristic(
          HAP.Characteristic.CurrentVisibilityState,
          input.hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN,
        );
        inputService.updateCharacteristic(
          HAP.Characteristic.TargetVisibilityState,
          input.hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN,
        );
      }
    });
  }

  #setInputName(inputService, value, callback) {
    // Allow input name change in HomeKit
    // Changes are reflected on device if configured to allow
    if (value != '' && typeof inputService == 'object') {
      inputService.updateCharacteristic(HAP.Characteristic.ConfiguredName, value);
      let index = this.deviceData.inputs.findIndex(
        ({ uri }) => this.#crc32(uri) == inputService.getCharacteristic(HAP.Characteristic.Identifier).value,
      );
      if (index != -1) {
        // Check if the input is flagged to allow name change on the device
        if (this.deviceData.inputs[index].canrename == true) {
          if (this.deviceData.inputs[index].uri.startsWith('PRESET') == true) {
            this.set({
              command:
                'OPTPN' +
                this.deviceData.inputs[index].uri.substring(6, 8) +
                value.substring(0, 8).padEnd(9, ' ') +
                this.deviceData.inputs[index].title.split(' ')[1],
            });
          } else {
            this.set({ command: 'SSFUN' + this.deviceData.inputs[index].uri + ' ' + value });
          }
        }
        this.cachedOptions.inputs = structuredClone(this.deviceData.inputs); // Deep copy
        this.cachedOptions.inputs[index].label = value;
      }
    }
  }

  #setInputVisability(inputService, value, callback) {
    // Allow enabling/disabling input within Homekit
    // Changes are reflected on device if configured to allow
    if (
      (value == HAP.Characteristic.CurrentVisibilityState.HIDDEN || value == HAP.Characteristic.CurrentVisibilityState.SHOWN) &&
      typeof inputService == 'object'
    ) {
      inputService.updateCharacteristic(HAP.Characteristic.CurrentVisibilityState, value);
      inputService.updateCharacteristic(HAP.Characteristic.TargetVisibilityState, value);
      let index = this.deviceData.inputs.findIndex(
        ({ uri }) => this.#crc32(uri) == inputService.getCharacteristic(HAP.Characteristic.Identifier).value,
      );
      if (typeof this.deviceData.inputs[index] == 'object') {
        // Check if the input is flagged to allow visablity change state on the device
        if (this.deviceData.inputs[index].canhide == true) {
          // Input is flagged to allow visablity change state on the device, so update there.
          if (this.deviceData.inputs[index].uri.startsWith('PRESET') == true) {
            this.set({
              command:
                'OPTPSTUNER' +
                this.deviceData.inputs[index].uri.substring(6, 8) +
                ' ' +
                (value == HAP.Characteristic.CurrentVisibilityState.SHOWN ? 'OFF' : 'ON'),
            });
          } else {
            this.set({
              command:
                'SSSOD' +
                this.deviceData.inputs[index].uri +
                ' ' +
                (value == HAP.Characteristic.CurrentVisibilityState.SHOWN ? 'USE' : 'DEL'),
            });
          }
        }
        this.cachedOptions.inputs = structuredClone(this.deviceData.inputs); // Deep copy
        this.cachedOptions.inputs[index].hidden = value == HAP.Characteristic.CurrentVisibilityState.HIDDEN ? true : false;
      }
    }
  }

  #buildInputs(includePresets) {
    this.deviceData.inputs.forEach((input) => {
      if ((includePresets == false && input.uri.startsWith('PRESET') == false) || includePresets == true) {
        let type = HAP.Characteristic.InputSourceType.HDMI;
        if (input.type == InputTypes.PRESET) type = HAP.Characteristic.InputSourceType.TUNER;
        if (input.type == InputTypes.TUNER) type = HAP.Characteristic.InputSourceType.TUNER;
        if (input.type == InputTypes.IPODUSB) type = HAP.Characteristic.InputSourceType.USB;
        if (input.type == InputTypes.NETWORK || input.type == InputTypes.BLUETOOTH) type = HAP.Characteristic.InputSourceType.AIRPLAY;
        if (input.type == InputTypes.SPOTIFY) type = HAP.Characteristic.InputSourceType.APPLICATION;

        // Add this input to the "master" accessory and set properties
        // Find the last subtype for InputSource and add 1 to it for this one
        let serviceSubtype = 1;
        this.HomeKitAccessory.services.forEach((service) => {
          if (service.UUID == HAP.Service.InputSource.UUID && service.subtype >= serviceSubtype) {
            serviceSubtype = service.subtype + 1;
          }
        });

        // Fix up input label to conform to HomKit namings
        input.label = HomeKitDevice.validateHomeKitName(input.label.replace('/', ' - '));

        let tempInput = this.HomeKitAccessory.addService(HAP.Service.InputSource, input.label, serviceSubtype);
        tempInput.updateCharacteristic(HAP.Characteristic.ConfiguredName, input.label);
        tempInput.updateCharacteristic(HAP.Characteristic.InputSourceType, type);
        tempInput.updateCharacteristic(HAP.Characteristic.IsConfigured, HAP.Characteristic.IsConfigured.CONFIGURED);
        tempInput.updateCharacteristic(
          HAP.Characteristic.CurrentVisibilityState,
          input.hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN,
        );
        tempInput.updateCharacteristic(
          HAP.Characteristic.TargetVisibilityState,
          input.hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN,
        );
        tempInput.updateCharacteristic(HAP.Characteristic.Identifier, this.#crc32(input.uri)); // Create a uuid for this input with a crc32 value of the inputs uri

        // Setup callbacks for characteristics
        if (input.canhide == true) {
          tempInput.getCharacteristic(HAP.Characteristic.TargetVisibilityState).on(HAP.CharacteristicEventTypes.SET, (value, callback) => {
            this.#setInputVisability(tempInput, value, callback);
          });
        }
        if (input.canrename == true) {
          tempInput.getCharacteristic(HAP.Characteristic.ConfiguredName).on(HAP.CharacteristicEventTypes.SET, (value, callback) => {
            this.#setInputName(tempInput, value, callback);
          });
        }

        tempInput.getCharacteristic(HAP.Characteristic.TargetVisibilityState).on(HAP.CharacteristicEventTypes.GET, (callback) => {
          callback(null, input.hidden);
        });
        tempInput.getCharacteristic(HAP.Characteristic.ConfiguredName).on(HAP.CharacteristicEventTypes.GET, (callback) => {
          callback(null, input.label);
        });

        this.AMPInputs.push(tempInput);
      }
    });
  }

  #crc32(valueToHash) {
    let crc32HashTable = [
      0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 0x00edb8832, 0x079dcb8a4,
      -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22,
      0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9,
      -0x5f0c29d, -0x72f7f20b, 0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95,
      0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 0x026d930ac, 0x051de003a,
      -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc,
      0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f,
      -0x60401b5b, -0x17472bcd, 0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff,
      0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 0x065b0d9c6, 0x012b7e950,
      -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e,
      0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5,
      -0x55f5b3a1, -0x22f28337, 0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61,
      0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, -0x12477ce0, -0x65404c4a,
      0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8,
      -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835,
      0x0196c3671, 0x06e6b06e7, -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5,
      -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, -0x27f2d426, -0x50f5e4b4,
      0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236,
      -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf,
      0x02cd99e8b, 0x05bdeae1d, -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713,
      -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, -0x792c2d2c, -0xe2b1dbe,
      0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c,
      -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909,
      0x04969474d, 0x03e6e77db, -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9,
      -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, -0x4c9985d2, -0x3b9eb548,
      0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d,
    ];
    let crc32 = 0xffffffff; // init crc32 hash;
    valueToHash = Buffer.from(valueToHash); // convert value into buffer for processing
    for (let index = 0; index < valueToHash.length; index++) {
      crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ (crc32 >>> 8)) & 0xffffffff;
    }
    crc32 ^= 0xffffffff;
    return crc32 >>> 0; // return crc32
  }
}

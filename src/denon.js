// Communcation with a Denon/Mirantz AV Receiver
// Part of homebridge-denon-accfactory
//
// Code version 21/10/2024
// Mark Hulskamp
'use strict';

// Define external module requirements
import { parseString } from 'xml2js';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { URL } from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import AVReceiver from './receiver.js';

const UPDTIMEOUT = 10000;
const UDPDISCOVERYDONE = 'UDPDISCOVERYDONE';
const SUBSCRIBEINTERVAL = 2000; // Get system details every 2 seconds

export default class DenonAccfactory {
  static Inputs = {
    PRESET: 'MEMORY',
    TUNER: 'RADIO',
    CD: 'CD',
    SATCBL: 'SAT/CBL',
    DVD: 'DVD',
    BLURAY: 'BLURAY',
    GAME: 'GAME',
    AUX: 'AUX',
    MEDIAPLAYER: 'MEDIAPLAYER',
    IPODUSB: 'IPOD/USB',
    TVAUDIO: 'TV',
    NETWORK: 'NET',
    BLUETOOTH: 'BLUETOOTH',
    SPOTIFY: 'SPOTIFY',
  };

  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = {}; // Object of confirmed connections
  #rawData = {}; // Cached copy of data from Rest and Telnet APIs
  #eventEmitter = new EventEmitter(); // Used for object messaging from this platform
  #connectionTimer = undefined;
  #trackedDevices = {}; // Object of devices we've created. used to track comms uuid. key'd by serial #

  constructor(log, config, api) {
    this.config = config;
    this.log = log;
    this.api = api;

    // Perform validation on the configuration passed into us and set defaults if not present
    this.config.options.autoDiscover = typeof this.config.options?.autoDiscover === 'boolean' ? this.config.options.autoDiscover : true;
    this.config.options.eveHistory = typeof this.config.options?.eveHistory === 'boolean' ? this.config.options.eveHistory : true;

    this.api.on('didFinishLaunching', async () => {
      // We got notified that Homebridge has finished loading, so we are ready to process
      await this.discoverDevices();
      Object.keys(this.#rawData).forEach((macAddress) => {
        this.#subscribeTelnet(macAddress);
      });

      // We'll check connection status every 1 minute
      clearInterval(this.#connectionTimer);
      this.#connectionTimer = setInterval(async () => {
        await this.discoverDevices();
        Object.keys(this.#rawData).forEach((macAddress) => {
          this.#subscribeTelnet(macAddress);
        });
      }, 60000);
    });

    this.api.on('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup some internal cleaning up
      Object.values(this.#connections).forEach((connection) => {
        if (connection.tcpSocket !== undefined) {
          connection.tcpSocket.end();
        }
      });
      clearInterval(this.#connectionTimer);
      this.#eventEmitter.removeAllListeners();
    });

    // Setup event listeners for set/get calls from devices if not already done so
    this.#eventEmitter.addListener(HomeKitDevice.SET, (uuid, values) => {
      this.#set(uuid, values);
    });
    this.#eventEmitter.addListener(HomeKitDevice.GET, async (uuid, values) => {
      let results = await this.#get(uuid, values);
      // Send the results back to the device via a special event (only if still active)
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(HomeKitDevice.GET + '->' + uuid, results);
      }
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info && this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async discoverDevices() {
    let timeoutTimer = undefined;

    if (this.config.options.autoDiscover === true) {
      this?.log?.debug && this.log.debug('Performing device discovery on local network');
      let udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      udpSocket.bind(30000, '0.0.0.0', () => {
        udpSocket.addMembership('224.0.0.1');
        udpSocket.setBroadcast(true);

        let udpQuery1 =
          'M-SEARCH * HTTP/1.1\r\n' + 'HOST:239.255.255.250:1900\r\n' + 'MAN:"ssdp:discover"\r\n' + 'ST:ssdp:all\r\n' + 'MX:2\r\n' + '\r\n';
        let udpQuery2 =
          'M-SEARCH * HTTP/1.1\r\n' +
          'HOST:239.255.255.250:1900\r\n' +
          'MAN:"ssdp:discover"\r\n' +
          'ST:upnp:rootdevice\r\n' +
          'MX:2\r\n' +
          '\r\n';
        let udpQuery3 =
          'M-SEARCH * HTTP/1.1\r\n' +
          'HOST:239.255.255.250:1900\r\n' +
          'MAN:"ssdp:discover"\r\n' +
          'ST:urn:schemas-upnp-org:device:MediaRenderer:1\r\n' +
          'MX:2\r\n' +
          '\r\n';
        udpSocket.send(udpQuery1, 0, udpQuery1.length, 1900, '239.255.255.250');
        udpSocket.send(udpQuery2, 0, udpQuery2.length, 1900, '239.255.255.250');
        udpSocket.send(udpQuery3, 0, udpQuery3.length, 1900, '239.255.255.250');

        timeoutTimer = setTimeout(() => {
          udpSocket.close();
          this.#eventEmitter.emit(UDPDISCOVERYDONE);
        }, UPDTIMEOUT);
      });

      udpSocket.on('message', async (chunk, info) => {
        // Callback triggered when we've received a UDP response
        let deviceInfo = await this.#getDeviceInfo(info.address);
        if (deviceInfo?.deviceInfo?.MacAddress !== undefined) {
          if (this.#rawData?.[deviceInfo.deviceInfo.MacAddress] === undefined) {
            // Not previously found this device
            this?.log?.debug && this.log.debug('Found device at "%s" with name "%s"', info.address, deviceInfo.sdp.friendlyName);
            this.#rawData[deviceInfo.deviceInfo.MacAddress] = {
              uuid: undefined,
              system: info.address,
              macAddress: deviceInfo.deviceInfo.MacAddress,
              tcpSocket: undefined,
              timer: undefined,
              value: {
                sdp: deviceInfo.sdp,
                deviceInfo: deviceInfo.deviceInfo,
                presets: deviceInfo.presets,
                GetAllZonePowerStatus: deviceInfo.GetAllZonePowerStatus,
                GetAllZoneMuteStatus: deviceInfo.GetAllZoneMuteStatus,
                GetAllZoneVolume: deviceInfo.GetAllZoneVolume,
                GetZoneName: deviceInfo.GetZoneName,
                GetAllZoneSource: deviceInfo.GetAllZoneSource,
                GetTunerStatus: deviceInfo.GetTunerStatus,
                GetRenameSource: deviceInfo.GetRenameSource,
                GetDeletedSource: deviceInfo.GetDeletedSource,
              },
            };
          }
          if (this.#rawData?.[deviceInfo?.deviceInfo?.MacAddress] !== undefined) {
            // Previously found this system, so check if IP/Host has changed and update if so
            if (this.#rawData[deviceInfo.deviceInfo.MacAddress].system !== info.address) {
              this?.log?.debug &&
                this.log.debug(
                  'Previously discovered device "%s" at "%s" has changed to "%s"',
                  deviceInfo.sdp.friendlyName,
                  this.#rawData?.[deviceInfo.deviceInfo.MacAddress].system,
                  info.address,
                );
            }
            this.#rawData[deviceInfo.deviceInfo.MacAddress].system = info.address;
          }
        }
      });

      // Wait until we get notified that discovery has completed/reached timeout
      await EventEmitter.once(this.#eventEmitter, UDPDISCOVERYDONE);
    }

    if (this.config.options.autoDiscover === false && Array.isArray(this.config?.devices) === true) {
      this.config.devices.forEach(async (device) => {
        if (device?.system !== undefined && device?.system !== '') {
          let deviceInfo = await this.#getDeviceInfo(device.system);
          if (deviceInfo?.deviceInfo?.MacAddress === undefined) {
            this?.log?.error && this.log.error('Specified device "%s" could not be contacted', device.system);
          }
          if (this.#rawData?.[deviceInfo.deviceInfo.MacAddress] === undefined) {
            // Not previously found this device
            this?.log?.debug && this.log.debug('Validated device at "%s" with name "%s"', device.system, deviceInfo.sdp.friendlyName);
            this.#rawData[deviceInfo.deviceInfo.MacAddress] = {
              uuid: undefined,
              system: device.system,
              macAddress: deviceInfo.deviceInfo.MacAddress,
              tcpSocket: undefined,
              timer: undefined,
              value: {
                sdp: deviceInfo.sdp,
                deviceInfo: deviceInfo.deviceInfo,
                presets: deviceInfo.presets,
                GetAllZonePowerStatus: deviceInfo.GetAllZonePowerStatus,
                GetAllZoneMuteStatus: deviceInfo.GetAllZoneMuteStatus,
                GetAllZoneVolume: deviceInfo.GetAllZoneVolume,
                GetZoneName: deviceInfo.GetZoneName,
                GetAllZoneSource: deviceInfo.GetAllZoneSource,
                GetTunerStatus: deviceInfo.GetTunerStatus,
                GetRenameSource: deviceInfo.GetRenameSource,
                GetDeletedSource: deviceInfo.GetDeletedSource,
              },
            };
            if (this.#rawData?.[deviceInfo?.deviceInfo?.MacAddress] !== undefined) {
              // Previously found this system, so check if IP/Host has changed and update if so
              if (this.#rawData[deviceInfo.deviceInfo.MacAddress].system !== device.system) {
                this?.log?.debug &&
                  this.log.debug(
                    'Configured system "%s" at "%s" has changed to "%s"',
                    deviceInfo.sdp.friendlyName,
                    this.#rawData[deviceInfo.deviceInfo.MacAddress].system,
                    device.system,
                  );
              }
              this.#rawData[deviceInfo.deviceInfo.MacAddress].system = device.system;
            }
          }
        }
      });
    }
  }

  async #subscribeTelnet(macAddress) {
    if (typeof this.#rawData?.[macAddress] !== 'object') {
      // Not a valid connection object
      return;
    }

    const DENON_COMMANDS = [
      'MU',
      'MV',
      'ZM',
      'Z2',
      'Z3',
      'SI',
      'TMAN',
      'TPMAN',
      'TPAN',
      'TFANNAME',
      'TFAN',
      'OPTPN',
      'OPTPSTUNER',
      'SSSOD',
      'SSFUN',
      'SSINFFRMAVR',
      'VIALLS/N.',
      'NSFRN',
      'R1',
      'R2',
      'R3',
      'SSVCTZMADIS',
    ];

    if (this.#rawData[macAddress].tcpSocket === undefined) {
      let reconnectViaREST = false;
      this.#rawData[macAddress].tcpSocket = net.createConnection({ host: this.#rawData[macAddress].system, port: 23 }, () => {
        this.#rawData[macAddress].tcpSocket.setKeepAlive(true); // Keep socket connection alive

        this?.log?.debug &&
          this.log.debug(
            'Established connection to "%s" at "%s" using Telnet API',
            this.#rawData[macAddress].value.sdp.friendlyName,
            this.#rawData[macAddress].system,
          );

        // Send some commands to get further details from the device
        this.#rawData[macAddress].tcpSocket.write('SSINFFRM ?\r'); // Allows to get firmware information.
        this.#rawData[macAddress].tcpSocket.write('VIALL?\r'); // Allows to get the "true" device serial number
      });

      // eslint-disable-next-line no-unused-vars
      this.#rawData[macAddress].tcpSocket.on('close', (hadError) => {
        this?.log?.debug &&
          this.log.debug(
            'Connection to "%s" at "%s" using Telnet API has closed',
            this.#rawData[macAddress].value.sdp.friendlyName,
            this.#rawData[macAddress].system,
          );

        this.#rawData[macAddress].tcpSocket = undefined;
      });

      this.#rawData[macAddress].tcpSocket.on('error', (error) => {
        if (error.code === 'ECONNREFUSED') {
          // Telnet connection refused, so revert to REST API
          reconnectViaREST = true;
        }
      });

      this.#rawData[macAddress].tcpSocket.on('data', (data) => {
        // Receievd data may contain more than one line of command strings, so we'll split the string into an array to process each line
        data
          .toString()
          .trim()
          .split('\r')
          .forEach((dataline) => {
            if (DENON_COMMANDS.filter((commandPrefix) => dataline.startsWith(commandPrefix)).length !== 0) {
              let command = DENON_COMMANDS.filter((commandPrefix) => dataline.startsWith(commandPrefix)); // AMP command
              command[1] = dataline.substring(command[0].length).trim(); // AMP command data

              // Process the AMPs command(s) and associated data for the command

              // Device info
              if (command[0] === 'SSINFFRMAVR') {
                // Device firmware version
                this.#rawData[macAddress].value.sdp.firmwareVersion = command[1];
              }
              if (command[0] === 'VIALLS/N.') {
                // Device serial number
                this.#rawData[macAddress].value.sdp.serialNumber = command[1];
              }
              if (command[0] === 'NSFRN') {
                // Device friendly name has changed
                this.#rawData[macAddress].value.sdp.friendlyName = command[1];
              }

              // Zone power on/off
              if (command[0] === 'ZM' && (command[1] === 'ON' || command[1] === 'OFF')) {
                // Main zone on/off
                this.#rawData[macAddress].value.GetAllZonePowerStatus.zone1 = command[1] === 'ON' ? 'ON' : 'OFF';
              }
              if (command[0] === 'Z2' && (command[1] === 'ON' || command[1] === 'OFF')) {
                // Zone2 on/off
                this.#rawData[macAddress].value.GetAllZonePowerStatus.zone2 = command[1] === 'ON' ? 'ON' : 'OFF';
              }
              if (command[0] === 'Z3' && (command[1] === 'ON' || command[1] === 'OFF')) {
                // Zone3 on/off
                this.#rawData[macAddress].value.GetAllZonePowerStatus.zone3 = command[1] === 'ON' ? 'ON' : 'OFF';
              }

              // Zone mute on/off
              if (command[0] === 'MU' && (command[1] === 'ON' || command[1] === 'OFF')) {
                // Main zone Mute On/Off
                this.#rawData[macAddress].value.GetAllZoneMuteStatus.zone1 = command[1] === 'ON' ? 'on' : 'off';
              }
              if (command[0] === 'Z2' && (command[1] === 'MUON' || command[1] === 'MUOFF')) {
                // Zone2 Mute On/Off
                this.#rawData[macAddress].value.GetAllZoneMuteStatus.zone2 = command[1] === 'MUON' ? 'on' : 'off';
              }
              if (command[0] === 'Z3' && (command[1] === 'MUON' || command[1] === 'MUOFF')) {
                // Zone3 Mute On/Off
                this.#rawData[macAddress].value.GetAllZoneMuteStatus.zone3 = command[1] === 'MUON' ? 'on' : 'off';
              }

              // Volume type change (Absolute 0-98 or Relative -79.5db to 18db)
              if (command[0] === 'SSVCTZMADIS' && (command[1] === 'ABS' || command[1] === 'REL')) {
                if (command[1] === 'REL') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.disptype = 'RELATIVE';
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.dispvalue =
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume + 'dB';
                  if (this.#rawData[macAddress].value.GetAllZoneVolume?.zone2 !== undefined) {
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone2.disptype = 'RELATIVE';
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone2.dispvalue =
                      this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume + 'dB';
                  }
                  if (this.#rawData[macAddress].value.GetAllZoneVolume?.zone3 !== undefined) {
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone3.disptype = 'RELATIVE';
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone3.dispvalue =
                      this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume + 'dB';
                  }
                }
                if (command[1] === 'ABS') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.disptype = 'ABSOLUTE';
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.dispvalue = (
                    Math.round(
                      (this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume !== '--'
                        ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume), -79.5, 18, 0, 98)
                        : 0.0) * 2,
                    ) * 0.5
                  ).toFixed(1);
                  if (this.#rawData[macAddress].value.GetAllZoneVolume?.zone2 !== undefined) {
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone2.disptype = 'ABSOLUTE';
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone2.dispvalue = (
                      Math.round(
                        (this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume !== '--'
                          ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume), -79.5, 18, 0, 98)
                          : 0.0) * 2,
                      ) * 0.5
                    ).toFixed(1);
                  }
                  if (typeof this.#rawData[macAddress].value.GetAllZoneVolume?.zone3 !== undefined) {
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone3.disptype = 'ABSOLUTE';
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone3.dispvalue = (
                      Math.round(
                        (this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume !== '--'
                          ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume), -79.5, 18, 0, 98)
                          : 0.0) * 2,
                      ) * 0.5
                    ).toFixed(1);
                  }
                }
              }

              // Zone volume change
              if (command[0] === 'MV' && isNaN(Number(command[1])) === false) {
                // Main zone volume change
                this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume =
                  Number(command[1]) !== 0 ? (-79.5 + Number(command[1].padEnd(3, '0')) / 10).toFixed(1).toString() : '--';
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone1.disptype === 'RELATIVE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.dispvalue =
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume + 'dB';
                }
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone1.disptype === 'ABSOLUTE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone1.dispvalue = (
                    Math.round(
                      (this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume !== '--'
                        ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone1.volume), -79.5, 18, 0, 98)
                        : 0.0) * 2,
                    ) * 0.5
                  ).toFixed(1);
                }
              }
              if (command[0] === 'MV' && command[1].split(' ') === 'MAX') {
                // Max volume limit
                //console.log("max volume", parseFloat(command[1].split(" ")[1]));
              }
              if (command[0] === 'Z2' && isNaN(Number(command[1])) === false) {
                // Zone2 volume change
                this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume =
                  Number(command[1]) !== 0 ? (-79.5 + Number(command[1].padEnd(3, '0')) / 10).toFixed(1).toString() : '--';
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone2.disptype === 'RELATIVE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone2.dispvalue =
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume + 'dB';
                }
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone2.disptype === 'ABSOLUTE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone2.dispvalue = (
                    Math.round(
                      (this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume !== '--'
                        ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone2.volume), -79.5, 18, 0, 98)
                        : 0.0) * 2,
                    ) * 0.5
                  ).toFixed(1);
                }
              }
              if (command[0] === 'Z3' && isNaN(Number(command[1])) === false) {
                // Zone3 volume change
                this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume =
                  Number(command[1]) !== 0 ? (-79.5 + Number(command[1].padEnd(3, '0')) / 10).toFixed(1).toString() : '--';
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone3.disptype === 'RELATIVE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone3.dispvalue =
                    this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume + 'dB';
                }
                if (this.#rawData[macAddress].value.GetAllZoneVolume.zone3.disptype === 'ABSOLUTE') {
                  this.#rawData[macAddress].value.GetAllZoneVolume.zone3.dispvalue = (
                    Math.round(
                      (this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume !== '--'
                        ? scaleValue(parseFloat(this.#rawData[macAddress].value.GetAllZoneVolume.zone3.volume), -79.5, 18, 0, 98)
                        : 0.0) * 2,
                    ) * 0.5
                  ).toFixed(1);
                }
              }

              // Zone name change
              if (command[0] === 'R1') {
                // Main zone name change
                this.#rawData[macAddress].value.GetZoneName.zone1 = command[1].substring(0, 10).padEnd(10, ' ') + '\r';
              }
              if (command[0] === 'R2') {
                // Zone2 name change
                this.#rawData[macAddress].value.GetZoneName.zone2 = command[1].substring(0, 10).padEnd(10, ' ') + '\r';
              }
              if (command[0] === 'R3') {
                // Zone3 name change
                this.#rawData[macAddress].value.GetZoneName.zone3 = command[1].substring(0, 10).padEnd(10, ' ') + '\r';
              }

              // Input change
              if (command[0] === 'SI') {
                // Main zone input change
                this.#rawData[macAddress].value.GetAllZoneSource.zone1.source = command[1];
              }
              if (
                command === 'Z2' &&
                isNaN(Number(command[1])) === true &&
                command[1] !== 'ON' &&
                command[1] !== 'OFF' &&
                command[1] !== 'MUON' &&
                command[1] !== 'MUOFF'
              ) {
                // Zone2 input change
                this.#rawData[macAddress].value.GetAllZoneSource.zone2.source = command[1];
              }
              if (
                command === 'Z3' &&
                isNaN(Number(command[1])) === true &&
                command[1] !== 'ON' &&
                command[1] !== 'OFF' &&
                command[1] !== 'MUON' &&
                command[1] !== 'MUOFF'
              ) {
                // Zone3 input change
                this.#rawData[macAddress].value.GetAllZoneSource.zone3.source = command[1];
              }

              // Tuner changes
              if (command[0] === 'TMAN' && (command[1] === 'FM' || command[1] === 'AM')) {
                // Tuner band changed
                this.#rawData[macAddress].value.GetTunerStatus.band = command[1];
              }
              if (command[0] === 'TMAN' && (command[1] === 'AUTO' || command[1] === 'MANUAL')) {
                // Tuner tuning mode changed
                this.#rawData[macAddress].value.GetTunerStatus.automanual = command[1];
              }
              if (command[0] === 'TFANNAME') {
                // Tuner station name changed
                this.#rawData[macAddress].value.GetTunerStatus.name = command[1] + '\r';
              }
              if (command[0] === 'TFAN' && isNaN(Number(command[1])) === false) {
                // Tuner frequency changed
                this.#rawData[macAddress].value.GetTunerStatus.frequency = (Number(command[1]) / 100).toFixed(2).toString();
              }
              if (command[0] === 'TPAN') {
                // Preset selected
                this.#rawData[macAddress].value.GetTunerStatus.presetno = command[1];
                this.#rawData[macAddress].value.GetTunerStatus.presetname = ''.padEnd(10, ' '); // Blank name padded
              }

              // Preset changes
              if (command[0] === 'OPTPN') {
                // Preset details ie: number, name and frequency
                if (command[1].substring(0, 2) === this.#rawData[macAddress].value.GetTunerStatus.presetno) {
                  this.#rawData[macAddress].value.GetTunerStatus.presetno = command[1].substring(0, 2);
                  this.#rawData[macAddress].value.GetTunerStatus.presetname = command[1].substring(2, 11).padEnd(10, ' ');
                  this.#rawData[macAddress].value.GetTunerStatus.frequency = (Number(command[1].substring(11, 17)) / 100)
                    .toFixed(2)
                    .toString();
                }

                let index = this.#rawData[macAddress].value.presets.findIndex((preset) => preset.$.table === command[1].substring(0, 2));
                if (index !== -1) {
                  this.#rawData[macAddress].value.presets[index].$.param = command[1].substring(2);
                }
              }
              if (command[0] === 'OPTPSTUNER' && (command[1].split(' ')[1] === 'ON' || command[1].split(' ')[1] === 'OFF')) {
                // Preset skipped or not. We'll use this for shown or hidden status
                let index = this.#rawData[macAddress].value.presets.findIndex((preset) => preset.$.table === command[1].split(' ')[0]);
                if (index !== -1) {
                  this.#rawData[macAddress].value.presets[index].$.skip = command[1].split(' ')[1];
                }
              }

              // Source name/hidden changes
              if (command[0] === 'SSSOD' || command === 'SSFUN') {
                let search = command[1].split(' ').toUpperCase();
                if (search === 'SAT/CBL') {
                  search = 'CBL/SAT';
                }
                if (search === 'BD') {
                  search = 'BLU-RAY';
                }
                if (search === 'MPLAY') {
                  search = 'MEDIA PLAYER';
                }
                if (search === 'USB/IPOD') {
                  search = 'IPOD/USB';
                }
                if (search === 'TV') {
                  search = 'TV AUDIO';
                }
                if (search === 'NET') {
                  search = 'NETWORK';
                }
                if (search === 'BT') {
                  search = 'BLUETOOTH';
                }
                if (search === 'SPOTIFY') {
                  search = 'SPOTIFYCONNECT';
                }

                if (command[0] === 'SSFUN') {
                  // Source name change
                  let index = this.#rawData[macAddress].value.GetRenameSource.functionrename.list.findIndex(
                    ({ name }) => name.toUpperCase() === search,
                  );
                  if (index !== -1) {
                    this.#rawData[macAddress].value.GetRenameSource.functionrename.list[index].rename = command[1].split(/ (.*)/s)[1]; // Split on first space in string
                  }
                }

                if (command[0] === 'SSSOD') {
                  // Hide/Show sources
                  let index = this.#rawData[macAddress].value.GetDeletedSource.functiondelete.list.findIndex(
                    ({ name }) => name.toUpperCase() === search,
                  );
                  if (index !== -1) {
                    this.#rawData[macAddress].value.GetDeletedSource.functiondelete.list[index].use =
                      command[1].split(' ')[1] === 'DEL' ? '0' : '1';
                  }
                }
              }

              // Process any updated data
              this.#processPostSubscribe();
            }
          });
      });
    }
  }

  async subscribeREST(macAddress) {
    if (typeof this.#rawData?.[macAddress] !== 'object') {
      // Not a valid connection object
      return;
    }

    if (this.#rawData[macAddress].timer === undefined) {
      this?.log?.debug &&
        this.log.debug(
          'Established connection to "%s" at "%s" using REST API',
          this.#rawData[macAddress].value.sdp.friendlyName,
          this.#rawData[macAddress].system,
        );

      let deviceInfo = await this.#getDeviceInfo(this.#rawData[macAddress].system);
      this.#rawData[deviceInfo.deviceInfo.MacAddress].value = {
        sdp: deviceInfo.sdp,
        deviceInfo: deviceInfo.deviceInfo,
        presets: deviceInfo.presets,
        GetAllZonePowerStatus: deviceInfo.GetAllZonePowerStatus,
        GetAllZoneMuteStatus: deviceInfo.GetAllZoneMuteStatus,
        GetAllZoneVolume: deviceInfo.GetAllZoneVolume,
        GetZoneName: deviceInfo.GetZoneName,
        GetAllZoneSource: deviceInfo.GetAllZoneSource,
        GetTunerStatus: deviceInfo.GetTunerStatus,
        GetRenameSource: deviceInfo.GetRenameSource,
        GetDeletedSource: deviceInfo.GetDeletedSource,
      };
    }
  }

  #processPostSubscribe() {
    Object.values(this.#processData('')).forEach((deviceData) => {
      if (this.#trackedDevices?.[deviceData?.hkUsername] === undefined && deviceData?.excluded === true) {
        // We haven't tracked this device before (ie: should be a new one) and but its excluded
        this?.log?.warn && this.log.warn('Device "%s" is ignored due to it being marked as excluded', deviceData.description);
      }

      if (this.#trackedDevices?.[deviceData?.hkUsername] === undefined && deviceData?.excluded === false) {
        // Denon AV Receiver - AUDIO_RECEIVER = 34
        let tempDevice = new AVReceiver(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
        tempDevice.add(deviceData.manufacturer + ' AVReceiver', 34, true);

        // Track this device once created
        this.#trackedDevices[deviceData.hkUsername] = {
          uuid: tempDevice.uuid,
        };
      }

      // Finally, if device is not excluded, send updated data to device for it to process
      if (deviceData.excluded === false && this.#trackedDevices?.[deviceData?.hkUsername] !== undefined) {
        this.#eventEmitter.emit(this.#trackedDevices[deviceData.hkUsername].uuid, HomeKitDevice.UPDATE, deviceData);
      }
    });
  }

  #processData(deviceUUID) {
    if (typeof deviceUUID !== 'string') {
      deviceUUID = '';
    }
    let devices = {};

    Object.entries(this.#rawData).forEach(([, value]) => {
      // process raw device data
      let tempDevice = {};
      tempDevice.excluded = this.config?.devices?.[value.value?.sdp?.serialNumber]?.exclude === true; // Mark device as excluded or not
      tempDevice.serialNumber = value.value.sdp.serialNumber;
      tempDevice.hkUsername = value.value.deviceInfo.MacAddress;
      tempDevice.softwareVersion =
        value.value.sdp?.firmwareVersion === undefined ? '0.0.0' : value.value.sdp.firmwareVersion.replace(/-/g, '.');
      tempDevice.manufacturer = value.value.sdp.friendlyName.split(' ')[0];
      tempDevice.model = value.value.sdp.friendlyName.split(' ')[1];
      tempDevice.description = makeHomeKitName(value.value.sdp.friendlyName);
      tempDevice.online = true;

      // build list of inputs (except for a tuner, which we'll handle seperately)
      tempDevice.inputs = [];
      value.value.GetRenameSource.functionrename.list.forEach((functionrename) => {
        if (functionrename.name.trim().toUpperCase() !== 'TUNER') {
          let uri = '';
          let canhide = false;
          let canrename = false;
          let type = '';
          if (functionrename.name.trim().toUpperCase() === 'CD') {
            uri = 'CD';
            type = DenonAccfactory.Inputs.CD;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'CBL/SAT') {
            uri = 'SAT/CBL'; // Yes, type name is different
            type = DenonAccfactory.Inputs.SATCBL;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'DVD') {
            uri = 'DVD';
            type = DenonAccfactory.Inputs.DVD;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'BLU-RAY') {
            uri = 'BD';
            type = DenonAccfactory.Inputs.BLURAY;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'GAME') {
            uri = 'GAME';
            type = DenonAccfactory.Inputs.BLURAY;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'AUX1') {
            uri = 'AUX1';
            type = DenonAccfactory.Inputs.AUX;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'AUX2') {
            uri = 'AUX2';
            type = DenonAccfactory.Inputs.AUX;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'MEDIA PLAYER') {
            uri = 'MPLAY';
            type = DenonAccfactory.Inputs.MEDIAPLAYER;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'IPOD/USB') {
            uri = 'USB/IPOD';
            type = DenonAccfactory.Inputs.IPODUSB;
            canhide = true;
            canrename = false;
          }
          if (functionrename.name.trim().toUpperCase() === 'TV AUDIO') {
            uri = 'TV';
            type = DenonAccfactory.Inputs.TVAUDIO;
            canhide = true;
            canrename = true;
          }
          if (functionrename.name.trim().toUpperCase() === 'NETWORK') {
            uri = 'NET';
            type = DenonAccfactory.Inputs.NETWORK;
            canhide = true;
            canrename = false;
          }
          if (functionrename.name.trim().toUpperCase() === 'BLUETOOTH') {
            uri = 'BT';
            type = DenonAccfactory.Inputs.BLUETOOTH;
            canhide = true;
            canrename = false;
          }
          if (functionrename.name.trim().toUpperCase() === 'SPOTIFYCONNECT') {
            uri = 'SPOTIFY';
            type = DenonAccfactory.Inputs.SPOTIFY;
            canhide = false;
            canrename = false;
          }
          if (type !== '') {
            let index = value.value.GetDeletedSource.functiondelete.list.findIndex(({ name }) => name === functionrename.name);
            let hidden = index !== -1 ? (Number(value.value.GetDeletedSource.functiondelete.list[index].use) === 0 ? true : false) : false;

            tempDevice.inputs.push({
              uri: uri,
              title: functionrename.name.trim(),
              label: functionrename.rename.trim(),
              connection: true,
              type: type,
              hidden: hidden,
              canhide: canhide,
              canrename: canrename,
            });
          }
        }
      });

      // build list of inputs for configured tuners, create seperate tuner inputs for each band present
      value.value.deviceInfo.DeviceZoneCapabilities[0].Operation.TunerOperation.BandList.Band.forEach((band) => {
        tempDevice.inputs.push({
          uri: 'TUNER' + band.Name.toUpperCase(),
          title: 'Tuner',
          label: 'Tuner ' + band.Name,
          connection: true,
          type: DenonAccfactory.Inputs.TUNER,
          hidden: false,
          canhide: false,
          canrename: false,
        });
      });

      // Build list of inputs for any presets
      value.value.presets.forEach((preset) => {
        if (preset.$.table !== 'OFF') {
          tempDevice.inputs.push({
            uri: 'PRESET' + preset.$.table,
            title: preset.$.band + ' ' + preset.$.param.substring(9, 15).trim(),
            label: preset.$.param.substring(0, 8).trim() !== '' ? preset.$.param.substring(0, 8).trim() : 'Preset' + preset.$.table,
            connection: true,
            type: DenonAccfactory.Inputs.PRESET,
            hidden: preset.$.skip.toUpperCase() === 'ON' ? true : false,
            canhide: true,
            canrename: true,
          });
        }
      });

      // Work out details for each zone we have, this includes name, power, volume, mute and input
      tempDevice.zones = [];
      for (let index = 0; index < Number(value.value.deviceInfo.DeviceZones[0]); index++) {
        let zoneName = 'zone' + (index + 1); // Zone name we're processing
        let tempZone = {};
        tempZone.name = value.value.GetZoneName[zoneName].trim();
        tempZone.power = value.value.GetAllZonePowerStatus[zoneName].toUpperCase() === 'ON' ? true : false;
        tempZone.volume =
          Math.round(
            (value.value.GetAllZoneVolume[zoneName].volume !== '--'
              ? scaleValue(parseFloat(value.value.GetAllZoneVolume[zoneName].volume), -79.5, 18, 0, 98)
              : 0.0) * 2,
          ) * 0.5;
        tempZone.mute = value.value.GetAllZoneMuteStatus[zoneName].toUpperCase() === 'ON' ? true : false;
        tempZone.input = '';
        tempZone.source = '';
        tempZone.label = '';

        tempDevice.inputs.forEach((input) => {
          if (
            (value.value.GetAllZoneSource[zoneName].source === 'SOURCE' || value.value.GetAllZoneSource[zoneName].source === '') &&
            index !== 0
          ) {
            // No specific input on zone, so match what the main zone is doing
            zoneName = 'zone1';
          }
          if (
            value.value.GetAllZoneSource[zoneName].source.split(/ (.*)/s)[0].toUpperCase() === input.uri.toUpperCase() ||
            (value.value.GetAllZoneSource[zoneName].source.split(/ (.*)/s)[0].toUpperCase() === 'AIRPLAY' &&
              input.uri.toUpperCase() === 'NET')
          ) {
            // Not a tuner input that is active
            tempZone.input = input.uri;
          }
          if (value.value.GetAllZoneSource[zoneName].source.toUpperCase() === 'TUNER') {
            let label = '';
            if (value.value.GetAllZoneSource[zoneName].source.toUpperCase() === 'TUNER') {
              label = value.value.GetTunerStatus.name.trim();
            }
            if (
              value.value.GetTunerStatus.presetno.toUpperCase() === 'OFF' &&
              'TUNER' + value.value.GetTunerStatus.band.toUpperCase() === input.uri.toUpperCase()
            ) {
              tempZone.input = input.uri;
              tempZone.label = label;
            }
            if (
              value.value.GetTunerStatus.presetno.toUpperCase() !== 'OFF' &&
              'PRESET' + value.value.GetTunerStatus.presetno === input.uri.toUpperCase()
            ) {
              tempZone.input = 'TUNER' + value.value.GetTunerStatus.band.toUpperCase();
              tempZone.source = input.uri.toUpperCase();
              tempZone.label = label;
            }
          }
        });

        tempDevice.zones.push(tempZone);
      }

      devices[tempDevice.serialNumber] = tempDevice; // Store processed device
    });

    return devices;
  }

  async #set(uuid, values) {
    if (typeof uuid !== 'string' || uuid === '' || typeof values !== 'object' || typeof this.#rawData?.[values?.uuid] !== 'object') {
      return;
    }

    if (this.#rawData?.[values?.uuid]?.tcpSocket?.readyState === 'open') {
      // we have an active TCP socket connection, so can send data via here
      this.#rawData[values.uuid].tcpSocket.write(values.command + '\r', () => {
        // Command sent via Telnet. Do we need ito anything now??
      });
    }

    if (
      this.#rawData?.[values?.uuid]?.tcpSocket === undefined ||
      (this.#rawData?.[values?.uuid]?.tcpSocket !== undefined && this.#rawData?.[values?.uuid]?.tcpSocket.readyState !== 'open')
    ) {
      // Not any open TCP socket, so send command via REST
      await fetchWrapper(
        'get',
        this.#rawData[deviceUUID].system + 'goform/formiPhoneAppDirect.xml/?' + values.command.replace(/ /g, '%20'), // Replace spaces with URL spaces character
        {},
      )
        .then((response) => {
          if (typeof response.status != 'number' || response.status != 200) {
            throw new Error('Denon API HTTP get failed with error');
          }
        })
        // eslint-disable-next-line no-unused-vars
        .catch((error) => {});

      // Small delay before we return to allow "paced" sending of commands via the REST API
      await setTimeout(() => {}, AMPCOMMANDDELAY);
    }
  }

  async #get(uuid) {}

  async #getDeviceInfo(system) {
    if (system === undefined || typeof system !== 'string' || system === '') {
      return;
    }

    let deviceInfo = undefined;

    // Need to try checking at port 80 and port 8080
    // also, two urls at that address
    // '/description.xml'
    // '/renderingcontrol/desc.xml'

    const FETCHURLS = [':8080/description.xml', ':8080/renderingcontrol/desc.xml', ':80/description.xml', ':80/renderingcontrol/desc.xml'];

    await Promise.all(
      FETCHURLS.map(async (url) => {
        await fetchWrapper('get', 'http://' + system + url, { timeout: 1000 })
          .then(async (response) => {
            let tempResponse = await response.text();
            let xmlObject = {};
            parseString(tempResponse, { explicitRoot: false, explicitArray: false, trim: true }, (error, result) => {
              xmlObject = result;
            });
            return xmlObject;
          })
          .then(async (sdpData) => {
            if (sdpData?.device?.presentationURL !== undefined && sdpData.device.presentationURL !== '') {
              await fetchWrapper('get', new URL(sdpData.device.presentationURL).origin + '/goform/Deviceinfo.xml', {})
                .then(async (response) => {
                  let tempResponse = await response.text();
                  let xmlObject = {};
                  parseString(tempResponse, { explicitRoot: false, explicitArray: false, trim: true }, (error, result) => {
                    xmlObject = result;
                  });
                  return xmlObject;
                })
                .then(async (deviceInfoData) => {
                  await fetchWrapper(
                    'post',
                    new URL(sdpData.device.presentationURL).origin + '/goform/AppCommand.xml',
                    {},
                    '<?xml version="1.0" encoding="utf-8"?> <tx> <cmd id="1">GetAllZonePowerStatus</cmd> <cmd id="1">GetAllZoneSource</cmd> <cmd id="1">GetAllZoneVolume</cmd> <cmd id="1">GetAllZoneMuteStatus</cmd> <cmd id="1">GetTunerStatus</cmd> <cmd id="1">GetRenameSource</cmd> <cmd id="1">GetDeletedSource</cmd> <cmd id="1">GetZoneName</cmd> </tx>',
                  )
                    .then(async (response) => {
                      let tempResponse = await response.text();
                      let xmlObject = {};
                      parseString(tempResponse, { explicitRoot: false, explicitArray: false, trim: true }, (error, result) => {
                        xmlObject = result;
                      });
                      return xmlObject;
                    })
                    .then(async (appCommandData) => {
                      await fetchWrapper('get', new URL(sdpData.device.presentationURL).origin + '/goform/formiPhoneAppTunerPreset.xml', {})
                        .then(async (response) => {
                          let tempResponse = await response.text();
                          let xmlObject = {};
                          parseString(tempResponse, { explicitRoot: false, explicitArray: false, trim: true }, (error, result) => {
                            xmlObject = result;
                          });
                          return xmlObject;
                        })
                        .then(async (presetData) => {
                          if (deviceInfoData?.MacAddress !== undefined) {
                            deviceInfoData.MacAddress = deviceInfoData.MacAddress.toUpperCase()
                              .toString('hex')
                              .split(/(..)/)
                              .filter((s) => s)
                              .join(':');

                            deviceInfo = {
                              sdp: sdpData.device,
                              deviceInfo: deviceInfoData,
                              GetAllZonePowerStatus: Object.values(appCommandData.cmd)[0],
                              GetAllZoneMuteStatus: Object.values(appCommandData.cmd)[3],
                              GetAllZoneVolume: Object.values(appCommandData.cmd)[2],
                              GetZoneName: Object.values(appCommandData.cmd)[7],
                              GetAllZoneSource: Object.values(appCommandData.cmd)[1],
                              GetTunerStatus: Object.values(appCommandData.cmd)[4],
                              GetRenameSource: Object.values(appCommandData.cmd)[5],
                              GetDeletedSource: Object.values(appCommandData.cmd)[6],
                              presets: presetData.PresetLists.value,
                            };
                          }
                        });
                    });
                });
            }
          })
          // eslint-disable-next-line no-unused-vars
          .catch((error) => {
            // Empty
          });
      }),
    );
    return deviceInfo;
  }
}

// General helper functions which don't need to be part of an object class
function makeHomeKitName(nameToMakeValid) {
  // Strip invalid characters to meet HomeKit naming requirements
  // Ensure only letters or numbers are at the beginning AND/OR end of string
  // Matches against uni-code characters
  return typeof nameToMakeValid === 'string'
    ? nameToMakeValid
        .replace(/[^\p{L}\p{N}\p{Z}\u2019.,-]/gu, '')
        .replace(/^[^\p{L}\p{N}]*/gu, '')
        .replace(/[^\p{L}\p{N}]+$/gu, '')
    : nameToMakeValid;
}

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
  if (value < sourceRangeMin) {
    value = sourceRangeMin;
  }
  if (value > sourceRangeMax) {
    value = sourceRangeMax;
  }
  return ((value - sourceRangeMin) * (targetRangeMax - targetRangeMin)) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}

async function fetchWrapper(method, url, options, data, response) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options?.timeout) > 0) {
    // If a timeout is specified in the options, setup here
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (options?.retry === undefined) {
    // If not retry option specifed , we'll do just once
    options.retry = 1;
  }

  options.method = method; // Set the HTTP method to use

  if (method === 'post' && typeof data !== undefined) {
    // Doing a HTTP post, so include the data in the body
    options.body = data;
  }

  if (options.retry > 0) {
    // eslint-disable-next-line no-undef
    response = await fetch(url, options);
    if (response.ok === false && options.retry > 1) {
      options.retry--; // One less retry to go

      // Try again after short delay (500ms)
      // We pass back in this response also for when we reach zero retries and still not successful
      await new Promise((resolve) => setTimeout(resolve, 500));
      // eslint-disable-next-line no-undef
      response = await fetchWrapper(method, url, options, data, structuredClone(response));
    }
    if (response.ok === false && options.retry === 0) {
      let error = new Error(response.statusText);
      error.code = response.status;
      throw error;
    }
  }

  return response;
}

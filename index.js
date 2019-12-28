var _ = require('underscore');
var TCA6416A = require('../node-tca6416a');
var Service, Characteristic, HomebridgeAPI;

const STATE_DECREASING = 0;
const STATE_INCREASING = 1;
const STATE_STOPPED = 2;

const TCA = new TCA6416A({address: 0x20, device: 1, debug: false });

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerAccessory('homebridge-gpio-blinds', 'Blinds', BlindsAccessory);
}

function BlindsAccessory(log, config) {
  _.defaults(config, {durationOffset: 0, activeLow: true, reedSwitchActiveLow: true});

  this.log = log;
  this.name = config['name'];
  this.pinUp = config['pinUp'];
  this.pinDown = config['pinDown'];
  this.durationUp = config['durationUp'];
  this.durationDown = config['durationDown'];
  this.durationOffset = config['durationOffset'];
  this.pinClosed = config['pinClosed'];
  this.pinOpen = config['pinOpen'];
  this.initialState = config['activeLow'] ? TCA.HIGH : TCA.LOW;
  this.activeState = config['activeLow'] ? TCA.LOW : TCA.HIGH;
  this.reedSwitchActiveState = config['reedSwitchActiveLow'] ? TCA.LOW : TCA.HIGH;

  this.cacheDirectory = HomebridgeAPI.user.persistPath();
  this.storage = require('node-persist');
  this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});

  var cachedCurrentPosition = this.storage.getItemSync(this.name);
  if((cachedCurrentPosition === undefined) || (cachedCurrentPosition === false)) {
		this.currentPosition = 0; // down by default
	} else {
		this.currentPosition = cachedCurrentPosition;
	}

  this.targetPosition = this.currentPosition;
  this.positionState = STATE_STOPPED; // stopped by default

  this.service = new Service.WindowCovering(this.name);

  this.infoService = new Service.AccessoryInformation();
  this.infoService
    .setCharacteristic(Characteristic.Manufacturer, 'Radoslaw Sporny')
    .setCharacteristic(Characteristic.Model, 'RaspberryPi GPIO Blinds')
    .setCharacteristic(Characteristic.SerialNumber, 'Version 1.1.2');

  this.finalBlindsStateTimeout;
  this.togglePinTimeout;
  this.intervalUp = this.durationUp / 100;
  this.intervalDown = this.durationDown / 100;
  this.currentPositionInterval;

  // use gpio pin numbering

  TCA.pinMode(this.pinUp, TCA.OUTPUT);
  TCA.pinMode(this.pinDown, TCA.OUTPUT);
  if (this.pinClosed) TCA.pinMode(this.pinClosed, TCA.INPUT_PULLUP);
  if (this.pinOpen) TCA.pinMode(this.pinOpen, TCA.INPUT_PULLUP);

  this.service
    .getCharacteristic(Characteristic.CurrentPosition)
    .on('get', this.getCurrentPosition.bind(this));

  this.service
    .getCharacteristic(Characteristic.PositionState)
    .on('get', this.getPositionState.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetPosition)
    .on('get', this.getTargetPosition.bind(this))
    .on('set', this.setTargetPosition.bind(this));
}

BlindsAccessory.prototype.getPositionState = function(callback) {
  this.log("Position state: %s", this.positionState);
  callback(null, this.positionState);
}

BlindsAccessory.prototype.getCurrentPosition = function(callback) {
  this.log("Current position: %s", this.currentPosition);
  callback(null, this.currentPosition);
}

BlindsAccessory.prototype.getTargetPosition = function(callback) {
  var updatedPosition;
  if (this.openCloseSensorMalfunction()) {
    this.log("Open and close reed switches are active, setting to 50");
    updatedPosition = 50;
  } else if (this.closedAndOutOfSync()) {
    this.log("Current position is out of sync, setting to 0");
    updatedPosition = 0;
  } else if (this.openAndOutOfSync()) {
    this.log("Current position is out of sync, setting to 100");
    updatedPosition = 100;
  } else if (this.partiallyOpenAndOutOfSync()) {
    this.log("Current position is out of sync, setting to 50");
    updatedPosition = 50;
  }
  if (updatedPosition !== undefined) {
    this.currentPosition = updatedPosition;
    this.targetPosition = updatedPosition;
    this.storage.setItemSync(this.name, updatedPosition);
  }
  this.log("Target position: %s", this.targetPosition);
  callback(null, this.targetPosition);
}

BlindsAccessory.prototype.setTargetPosition = function(position, callback) {
  this.log("Setting target position to %s", position);
  this.targetPosition = position;
  var moveUp = (this.targetPosition >= this.currentPosition);
  var duration;

  if (this.positionState != STATE_STOPPED) {
    this.log("Blind is moving, current position %s", this.currentPosition);
    if (this.oppositeDirection(moveUp)) {
      this.log('Stopping the blind because of opposite direction');
      TCA.digitalWrite((moveUp ? this.pinDown : this.pinUp), this.initialState);
    }
    clearInterval(this.currentPositionInterval);
    clearTimeout(this.finalBlindsStateTimeout);
    clearTimeout(this.togglePinTimeout);
  }

  if (this.currentPosition == position) {
    this.log('Current position already matches target position. There is nothing to do.');
    callback();
    return true;
  }

  // Specific Timing Func
  const timeDuration = (x) => { return x < 0.0926 ? x * 3.125 : 0.214783 + 0.805217 * x }

  if (moveUp) {
    duration = Math.round((timeDuration(this.targetPosition / 100) - timeDuration(this.currentPosition / 100)) * this.durationUp);
    this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalUp);
  } else {
    duration = Math.round((timeDuration(this.currentPosition / 100) - timeDuration(this.targetPosition / 100)) * this.durationDown);
    this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalDown);
  }

  this.log((moveUp ? 'Moving up' : 'Moving down') + ". Duration: %s ms.", duration);

  this.service.setCharacteristic(Characteristic.PositionState, (moveUp ? STATE_INCREASING : STATE_DECREASING));
  this.positionState = (moveUp ? STATE_INCREASING : STATE_DECREASING);

  this.finalBlindsStateTimeout = setTimeout(this.setFinalBlindsState.bind(this), duration);
  this.togglePin((moveUp ? this.pinUp : this.pinDown), duration);

  callback();
  return true;
}

BlindsAccessory.prototype.togglePin = function(pin, duration) {
  this.log("TOGGLE %d %d %d", pin, duration, TCA.digitalReadSync(pin))
  if (TCA.digitalReadSync(pin) != this.activeState) TCA.digitalWrite(pin, this.activeState);
  if (this.durationOffset && (this.targetPosition == 0 || this.targetPosition == 100)) this.duration += this.durationOffset;
  this.togglePinTimeout = setTimeout(function() {
    TCA.digitalWrite(pin, this.initialState);
  }.bind(this), parseInt(duration));
}

BlindsAccessory.prototype.setFinalBlindsState = function() {
  clearInterval(this.currentPositionInterval);
  this.positionState = STATE_STOPPED;
  this.service.setCharacteristic(Characteristic.PositionState, STATE_STOPPED);
  this.service.setCharacteristic(Characteristic.CurrentPosition, this.targetPosition);
  this.currentPosition = this.targetPosition;
  this.storage.setItemSync(this.name, this.currentPosition);
  this.log("Successfully moved to target position: %s", this.targetPosition);
}

BlindsAccessory.prototype.setCurrentPosition = function(moveUp) {
  if (moveUp) {
    this.currentPosition++;
  } else {
    this.currentPosition--;
  }
  this.storage.setItemSync(this.name, this.currentPosition);
}

BlindsAccessory.prototype.closedAndOutOfSync = function() {
  return this.currentPosition != 0 && this.pinClosed && (TCA.digitalReadSync(this.pinClosed) == this.reedSwitchActiveState);
}

BlindsAccessory.prototype.openAndOutOfSync = function() {
  return this.currentPosition != 100 && this.pinOpen && (TCA.digitalReadSync(this.pinOpen) == this.reedSwitchActiveState);
}

BlindsAccessory.prototype.partiallyOpenAndOutOfSync = function() {
  return (this.currentPosition == 0 && this.pinClosed && (TCA.digitalReadSync(this.pinClosed) != this.reedSwitchActiveState)) ||
         (this.currentPosition == 100 && this.pinOpen && (TCA.digitalReadSync(this.pinOpen) != this.reedSwitchActiveState));
}

BlindsAccessory.prototype.openCloseSensorMalfunction = function() {
  return (this.pinClosed && this.pinOpen &&
         (TCA.digitalReadSync(this.pinClosed) == this.reedSwitchActiveState) &&
         (TCA.digitalReadSync(this.pinOpen) == this.reedSwitchActiveState));
}

BlindsAccessory.prototype.oppositeDirection = function(moveUp) {
  return (this.positionState == STATE_INCREASING && !moveUp) || (this.positionState == STATE_DECREASING && moveUp);
}

BlindsAccessory.prototype.getServices = function() {
  return [this.infoService, this.service];
}

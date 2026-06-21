const { v4: uuidv4 } = require('uuid');
const { getStore } = require('../utils/jsonlStore');

const stores = {
  zones: () => getStore('zones'),
  locations: () => getStore('locations'),
  skus: () => getStore('skus'),
  waveRules: () => getStore('waveRules'),
  users: () => getStore('users'),
  configs: () => getStore('configs'),
  waves: () => getStore('waves'),
  pickingRecords: () => getStore('pickingRecords'),
  checkRecords: () => getStore('checkRecords'),
  alerts: () => getStore('alerts'),
  waveSuspensions: () => getStore('waveSuspensions'),
  waveTransfers: () => getStore('waveTransfers')
};

const newId = () => uuidv4().replace(/-/g, '');

module.exports = { stores, newId };

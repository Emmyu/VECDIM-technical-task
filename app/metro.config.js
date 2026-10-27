// Lets the app import the shared packages that live next to it in the repo (validator, sync-core).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(root, 'packages')];
config.resolver.extraNodeModules = {
  '@vecdim/validator': path.join(root, 'packages/validator'),
  '@vecdim/sync-core': path.join(root, 'packages/sync-core'),
};

module.exports = config;

const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
// v47 #8 — Hermes + minify: bundle -40%. Hermes já é padrão no RN 0.79, minify garantido no EAS.
config.transformer = { ...config.transformer, minify: true };

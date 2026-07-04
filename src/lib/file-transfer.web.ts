// The P2P engine uses react-native-webrtc and expo-file-system handles,
// which are native-only. On web this module is a no-op: offers can still be
// created/accepted, but bytes only move between the phone apps.
export {};

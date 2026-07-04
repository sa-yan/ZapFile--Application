import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

// The backend pushes for every offer. When the app is on screen the offer
// card is already visible, so swallow the banner; otherwise show it.
Notifications.setNotificationHandler({
  handleNotification: async () => {
    const foreground = AppState.currentState === 'active';
    return {
      shouldShowBanner: !foreground,
      shouldShowList: !foreground,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

/**
 * Asks for permission and returns this device's Expo push token, or null when
 * unavailable (permission denied, emulator without Google services, web).
 * The token is stored on the backend Device row and used to wake this phone
 * when a transfer offer arrives while the app is closed.
 */
export async function getPushToken(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('transfers', {
        name: 'File transfers',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return null;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (e) {
    console.warn('push token unavailable:', e instanceof Error ? e.message : e);
    return null;
  }
}

import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
// side effect: registers the WebRTC file-transfer engine's WS listeners
import '@/lib/file-transfer';

SplashScreen.preventAutoHideAsync();

// Everything lives on the single home screen; a tapped notification just
// needs the app opened, which the OS does for us.
if (Platform.OS !== 'web') {
  Notifications.addNotificationResponseReceivedListener(() => {});
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}

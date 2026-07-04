import { getContentUriAsync } from 'expo-file-system/legacy';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

// Resolved lazily and only if the native module is compiled into this build —
// returns null (instead of crashing) on builds that predate expo-intent-launcher.
const IntentLauncher = Platform.OS === 'android'
  ? requireOptionalNativeModule<{
      startActivity: (action: string, params: Record<string, unknown>) => Promise<unknown>;
    }>('ExpoIntentLauncher')
  : null;

/**
 * Opens a received file in whatever app handles its type (PDF viewer,
 * video player, ...). Falls back to the share sheet when direct opening
 * isn't possible (no handler app, old build, or iOS where the share
 * sheet's preview is the idiom).
 */
export async function openFile(uri: string, mimeType: string | null, fileName: string) {
  if (IntentLauncher) {
    try {
      // file:// URIs can't cross app boundaries; convert to content://
      const contentUri = await getContentUriAsync(uri);
      await IntentLauncher.startActivity('android.intent.action.VIEW', {
        data: contentUri,
        type: mimeType ?? '*/*',
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      });
      return;
    } catch {
      // no app installed for this type — fall through to the share sheet
    }
  }
  await Sharing.shareAsync(uri, {
    mimeType: mimeType ?? undefined,
    dialogTitle: fileName,
  }).catch(() => {});
}

import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Accent, Spacing } from '@/constants/theme';
import { extractPairCode } from '@/lib/pair-link';

// Required lazily: an APK built before expo-camera was added would crash at
// startup on a top-level import. This way old builds get a message instead.
let cameraModule: typeof import('expo-camera') | null | undefined;
function getCamera() {
  if (cameraModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cameraModule = require('expo-camera');
    } catch {
      cameraModule = null;
    }
  }
  return cameraModule;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called once with the pairing code from the first valid QR. */
  onCode: (code: string) => void;
}

/** Full-screen camera modal that scans a friend's pairing QR. */
export function QrScannerModal({ visible, onClose, onCode }: Props) {
  if (!visible) return null;
  const cam = getCamera();

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {cam ? (
          <Scanner cam={cam} onCode={onCode} />
        ) : (
          <View style={styles.message}>
            <ThemedText style={styles.messageText}>
              This build doesn&apos;t include the camera module yet. Install the latest
              development build to scan QR codes.
            </ThemedText>
          </View>
        )}
        <View style={styles.overlay} pointerEvents="box-none">
          <ThemedText style={styles.hint}>Point at your friend&apos;s QR code</ThemedText>
          <Pressable style={styles.cancelButton} onPress={onClose}>
            <ThemedText style={styles.cancelText}>Cancel</ThemedText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Scanner({
  cam,
  onCode,
}: {
  cam: NonNullable<ReturnType<typeof getCamera>>;
  onCode: (code: string) => void;
}) {
  const { CameraView, useCameraPermissions } = cam;
  const [permission, requestPermission] = useCameraPermissions();
  // onBarcodeScanned keeps firing every frame; only act on the first hit.
  const handled = useRef(false);

  if (!permission) return null;

  if (!permission.granted) {
    return (
      <View style={styles.message}>
        <ThemedText style={styles.messageText}>
          ZapFile needs the camera to scan pairing QR codes.
        </ThemedText>
        {permission.canAskAgain ? (
          <Pressable style={styles.allowButton} onPress={requestPermission}>
            <ThemedText style={styles.allowText}>Allow camera</ThemedText>
          </Pressable>
        ) : (
          <ThemedText style={styles.messageText}>
            Camera access is blocked — enable it in system settings.
          </ThemedText>
        )}
      </View>
    );
  }

  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={({ data }) => {
        if (handled.current) return;
        const code = extractPairCode(data);
        if (!code) return; // unrelated QR — keep scanning
        handled.current = true;
        onCode(code);
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.four,
    paddingBottom: Spacing.six,
  },
  hint: {
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },
  cancelButton: {
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.five,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  cancelText: {
    color: '#fff',
    fontWeight: '600',
  },
  message: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.five,
  },
  messageText: {
    color: '#fff',
    textAlign: 'center',
  },
  allowButton: {
    backgroundColor: Accent,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  allowText: {
    color: '#fff',
    fontWeight: '600',
  },
});

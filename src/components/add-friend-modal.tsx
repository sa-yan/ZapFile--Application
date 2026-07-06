import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import QRCode from 'react-native-qrcode-svg';

import { Avatar } from '@/components/avatar';
import { QrScannerModal } from '@/components/qr-scanner-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, Spacing } from '@/constants/theme';
import { buildPairLink } from '@/lib/pair-link';
import { useFriends } from '@/store/friends';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/** Bottom sheet with the pairing code, code entry and pending requests. */
export function AddFriendModal({ visible, onClose }: Props) {
  const { myCode, requests, generateCode, redeemCode, accept, decline } = useFriends();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const dark = useColorScheme() === 'dark';

  const shareCode = () => {
    if (!myCode) return;
    Share.share({ message: `Add me on ZapFile with pairing code: ${myCode.code}` });
  };

  const redeem = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      await redeemCode(code);
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (code: string) => {
    setScanOpen(false);
    redeem(code);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <ThemedView type="backgroundElement" style={styles.sheet}>
        <View style={styles.grabber} />
        <ThemedText type="subtitle">Add a friend</ThemedText>

        {myCode ? (
          <Pressable onPress={shareCode} style={styles.qrBlock}>
            <View style={styles.qrBox}>
              <QRCode
                value={buildPairLink(myCode.code)}
                size={160}
                backgroundColor="#fff"
                color="#111"
              />
            </View>
            <ThemedText type="subtitle" style={styles.code}>
              {myCode.code}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
              Have a friend scan this, or tap to share the code
            </ThemedText>
          </Pressable>
        ) : (
          <Pressable style={styles.button} onPress={generateCode}>
            <ThemedText style={styles.buttonText}>Get my pairing code</ThemedText>
          </Pressable>
        )}

        <View style={styles.redeemRow}>
          <TextInput
            style={[styles.input, dark && styles.inputDark]}
            placeholder="Friend's code"
            placeholderTextColor="#888"
            value={input}
            onChangeText={setInput}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.button, (!input.trim() || busy) && styles.buttonDisabled]}
            disabled={!input.trim() || busy}
            onPress={() => redeem(input)}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <ThemedText style={styles.buttonText}>Add</ThemedText>
            )}
          </Pressable>
        </View>

        <Pressable
          style={[styles.scanButton, busy && styles.buttonDisabled]}
          disabled={busy}
          onPress={() => setScanOpen(true)}>
          <ThemedText style={styles.scanButtonText}>Scan a friend&apos;s QR code</ThemedText>
        </Pressable>

        {error && (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        )}

        {requests.length > 0 && (
          <View style={styles.requests}>
            <ThemedText type="smallBold">Requests</ThemedText>
            {requests.map((r) => (
              <View key={r.friendshipId} style={styles.requestRow}>
                <Avatar name={r.displayName} size={40} />
                <ThemedText style={styles.requestName} numberOfLines={1}>
                  {r.displayName}
                </ThemedText>
                <Pressable
                  style={[styles.button, styles.smallButton]}
                  onPress={() => accept(r.friendshipId)}>
                  <ThemedText style={styles.buttonText}>Accept</ThemedText>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.smallButton, styles.declineButton]}
                  onPress={() => decline(r.friendshipId)}>
                  <ThemedText style={styles.buttonText}>Decline</ThemedText>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ThemedView>
      <QrScannerModal visible={scanOpen} onClose={() => setScanOpen(false)} onCode={onScanned} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    gap: Spacing.three,
    padding: Spacing.four,
    paddingBottom: Spacing.five,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#888',
    opacity: 0.5,
  },
  code: {
    textAlign: 'center',
    letterSpacing: 4,
    color: Accent,
  },
  qrBlock: {
    alignItems: 'center',
    gap: Spacing.two,
  },
  qrBox: {
    // white quiet zone so the QR scans in dark mode too
    backgroundColor: '#fff',
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  scanButton: {
    borderWidth: 1,
    borderColor: Accent,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  scanButtonText: {
    color: Accent,
    fontWeight: '600',
  },
  centered: {
    textAlign: 'center',
  },
  redeemRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: 16,
    color: '#111',
    backgroundColor: '#fff',
  },
  inputDark: {
    color: '#eee',
    backgroundColor: '#1a1a1d',
    borderColor: '#333',
  },
  button: {
    backgroundColor: Accent,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  smallButton: {
    paddingVertical: Spacing.two,
  },
  declineButton: {
    backgroundColor: '#e5484d',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  error: {
    color: '#e5484d',
    textAlign: 'center',
  },
  requests: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  requestName: {
    flex: 1,
  },
});

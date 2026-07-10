import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/store/auth';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * Bottom sheet confirming permanent account deletion (Play Store requires an
 * in-app path). The backend re-checks the password before deleting anything.
 */
export function DeleteAccountModal({ visible, onClose }: Props) {
  const deleteAccount = useAuth((s) => s.deleteAccount);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = useColorScheme() === 'dark';

  const close = () => {
    setPassword('');
    setError(null);
    onClose();
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      // success unmounts the whole logged-in tree; nothing left to close
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete account');
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : close} />
      <ThemedView type="backgroundElement" style={styles.sheet}>
        <View style={styles.grabber} />
        <ThemedText type="subtitle" style={styles.danger}>
          Delete account
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          This permanently deletes your account, devices, friend connections and transfer
          history. Files already saved on your devices are not affected. This cannot be undone.
        </ThemedText>
        <TextInput
          style={[styles.input, dark && styles.inputDark]}
          placeholder="Confirm your password"
          placeholderTextColor="#888"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {error && (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        )}
        <Pressable
          style={[styles.deleteButton, (!password || busy) && styles.buttonDisabled]}
          disabled={!password || busy}
          onPress={confirm}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <ThemedText style={styles.buttonText}>Delete my account forever</ThemedText>
          )}
        </Pressable>
        <Pressable style={styles.cancelButton} disabled={busy} onPress={close}>
          <ThemedText themeColor="textSecondary">Cancel</ThemedText>
        </Pressable>
      </ThemedView>
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
  danger: {
    color: '#e5484d',
  },
  input: {
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
  deleteButton: {
    backgroundColor: '#e5484d',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  error: {
    color: '#e5484d',
    textAlign: 'center',
  },
});

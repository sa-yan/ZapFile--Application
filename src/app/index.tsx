import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddFriendModal } from '@/components/add-friend-modal';
import { Avatar } from '@/components/avatar';
import { ProgressRing } from '@/components/progress-ring';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, MaxContentWidth, Spacing } from '@/constants/theme';
import { formatBytes } from '@/lib/format';
import { openFile } from '@/lib/open-file';
import { zapWs } from '@/lib/ws';
import { useAuth } from '@/store/auth';
import { useFriends } from '@/store/friends';
import { incomingOffers, outgoingOffers, useTransfers, type Batch } from '@/store/transfers';
import type { FriendResponse, TransferResponse } from '@/types/api';

// --- auth (unchanged flow, accent restyle) ---

function AuthForm() {
  const { login, register, busy, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const dark = useColorScheme() === 'dark';

  const inputStyle = [styles.input, dark && styles.inputDark];
  const canSubmit =
    email.includes('@') && password.length >= 8 && (mode === 'login' || displayName.length >= 2);

  const submit = () => {
    if (mode === 'login') login(email, password);
    else register(email, password, displayName);
  };

  return (
    <View style={styles.authWrap}>
      <ThemedView type="backgroundElement" style={styles.card}>
        <ThemedText type="title" style={[styles.centered, { color: Accent }]}>
          ZapFile
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </ThemedText>

        {mode === 'register' && (
          <TextInput
            style={inputStyle}
            placeholder="Display name"
            placeholderTextColor="#888"
            value={displayName}
            onChangeText={setDisplayName}
            autoCapitalize="words"
          />
        )}
        <TextInput
          style={inputStyle}
          placeholder="Email"
          placeholderTextColor="#888"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <TextInput
          style={inputStyle}
          placeholder="Password (min 8 characters)"
          placeholderTextColor="#888"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        {error && (
          <ThemedText type="small" style={styles.error}>
            {error}
          </ThemedText>
        )}

        <Pressable
          style={[styles.button, (!canSubmit || busy) && styles.buttonDisabled]}
          disabled={!canSubmit || busy}
          onPress={submit}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <ThemedText style={styles.buttonText}>
              {mode === 'login' ? 'Log in' : 'Register'}
            </ThemedText>
          )}
        </Pressable>

        <Pressable onPress={() => setMode(mode === 'login' ? 'register' : 'login')}>
          <ThemedText type="small" style={styles.centered}>
            {mode === 'login' ? 'No account? Register' : 'Have an account? Log in'}
          </ThemedText>
        </Pressable>
      </ThemedView>
    </View>
  );
}

// --- send directly row ---

function FriendBubble({ friend }: { friend: FriendResponse }) {
  const online = useFriends((s) => s.online[friend.userId] ?? false);
  const sendFiles = useTransfers((s) => s.sendFiles);
  const [sending, setSending] = useState(false);

  const pickAndSend = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (result.canceled || result.assets.length === 0) return;
    setSending(true);
    try {
      await sendFiles(
        friend.userId,
        result.assets.map((a) => ({
          fileName: a.name,
          fileSize: a.size ?? 0,
          mimeType: a.mimeType,
          uri: a.uri,
        })),
      );
    } catch (e) {
      Alert.alert('Could not send', e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  return (
    <Pressable style={styles.bubble} onPress={pickAndSend} disabled={sending}>
      <View>
        <Avatar name={friend.displayName} online={online} />
        {sending && (
          <View style={styles.bubbleSpinner}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
      </View>
      <ThemedText type="small" numberOfLines={2} style={styles.bubbleLabel}>
        {friend.displayName}
      </ThemedText>
    </Pressable>
  );
}

function SendDirectly({ onAddFriend }: { onAddFriend: () => void }) {
  const friends = useFriends((s) => s.friends);
  const requests = useFriends((s) => s.requests);

  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" style={{ color: Accent }}>
        Send directly
      </ThemedText>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bubbleRow}>
        {friends.map((f) => (
          <FriendBubble key={f.friendshipId} friend={f} />
        ))}
        <Pressable style={styles.bubble} onPress={onAddFriend}>
          <View>
            <View style={styles.addCircle}>
              <ThemedText style={styles.addPlus}>+</ThemedText>
            </View>
            {requests.length > 0 && <View style={styles.requestBadge} />}
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.bubbleLabel}>
            Add friend
          </ThemedText>
        </Pressable>
      </ScrollView>
      {friends.length === 0 && (
        <ThemedText type="small" themeColor="textSecondary">
          Add a friend to start sending — tap +
        </ThemedText>
      )}
    </View>
  );
}

// --- offers / active / received feed ---

function batchSize(batch: Batch): string {
  return formatBytes(batch.transfers.reduce((sum, t) => sum + t.fileSize, 0));
}

function IncomingOfferCard({ batch }: { batch: Batch }) {
  const { acceptOffer, declineOffer } = useTransfers();
  const t0 = batch.transfers[0];
  return (
    <ThemedView type="backgroundSelected" style={styles.card}>
      <View style={styles.offerHeader}>
        <Avatar name={t0.senderDisplayName} size={40} />
        <ThemedText type="smallBold" style={styles.offerTitle}>
          {t0.senderDisplayName} wants to send {batch.transfers.length}{' '}
          {batch.transfers.length === 1 ? 'file' : 'files'} ({batchSize(batch)})
        </ThemedText>
      </View>
      {batch.transfers.map((t) => (
        <ThemedText key={t.id} type="small" themeColor="textSecondary" numberOfLines={1}>
          {t.fileName} · {formatBytes(t.fileSize)}
        </ThemedText>
      ))}
      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.flex1]} onPress={() => acceptOffer(batch.batchId)}>
          <ThemedText style={styles.buttonText}>Accept</ThemedText>
        </Pressable>
        <Pressable
          style={[styles.button, styles.flex1, styles.declineButton]}
          onPress={() => declineOffer(batch.batchId)}>
          <ThemedText style={styles.buttonText}>Decline</ThemedText>
        </Pressable>
      </View>
    </ThemedView>
  );
}

function OutgoingOfferCard({ batch }: { batch: Batch }) {
  const cancelOffer = useTransfers((s) => s.cancelOffer);
  const t0 = batch.transfers[0];
  return (
    <ThemedView type="backgroundElement" style={[styles.card, styles.rowCard]}>
      <ActivityIndicator color={Accent} />
      <ThemedText type="small" style={styles.flex1} numberOfLines={2}>
        Waiting for {t0.receiverDisplayName} to accept {batch.transfers.length}{' '}
        {batch.transfers.length === 1 ? 'file' : 'files'}
      </ThemedText>
      <Pressable onPress={() => cancelOffer(batch.batchId)}>
        <ThemedText type="small" style={{ color: '#e5484d' }}>
          Cancel
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

function ActiveRow({ transfer, myUserId }: { transfer: TransferResponse; myUserId: string }) {
  const cancelOffer = useTransfers((s) => s.cancelOffer);
  const sent = transfer.senderUserId === myUserId;
  return (
    <ThemedView type="backgroundElement" style={[styles.card, styles.rowCard]}>
      <ProgressRing
        size={56}
        strokeWidth={5}
        progress={transfer.fileSize > 0 ? transfer.bytesTransferred / transfer.fileSize : 0}
        color={Accent}
      />
      <View style={styles.flex1}>
        <ThemedText type="small" numberOfLines={1}>
          {transfer.fileName}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {sent ? `Sending to ${transfer.receiverDisplayName}` : `Receiving from ${transfer.senderDisplayName}`}
        </ThemedText>
      </View>
      <Pressable onPress={() => cancelOffer(transfer.batchId)} hitSlop={Spacing.three}>
        <ThemedText type="subtitle" themeColor="textSecondary" style={styles.cancelX}>
          ×
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE';
}

function HistoryItem({ transfer, myUserId }: { transfer: TransferResponse; myUserId: string }) {
  const received = useTransfers((s) => s.receivedFiles[transfer.id]);
  const sent = transfer.senderUserId === myUserId;
  const other = sent ? transfer.receiverDisplayName : transfer.senderDisplayName;
  const failed = ['DECLINED', 'CANCELLED', 'FAILED'].includes(transfer.status);
  const statusWord = failed ? transfer.status.toLowerCase() : sent ? 'sent' : 'received';

  const share = () => {
    if (!received) return;
    Sharing.shareAsync(received.uri, {
      mimeType: received.mimeType ?? undefined,
      dialogTitle: received.fileName,
    }).catch(() => {});
  };

  const open = () => {
    if (!received) return;
    openFile(received.uri, received.mimeType, received.fileName);
  };

  return (
    <Pressable style={styles.historyRow} onPress={received ? open : undefined}>
      {received?.mimeType?.startsWith('image/') ? (
        <Image source={{ uri: received.uri }} style={styles.rowThumbnail} contentFit="cover" />
      ) : (
        <View style={[styles.extBadge, { backgroundColor: Accent + '26' }]}>
          <ThemedText type="small" style={{ color: Accent }}>
            {fileExt(transfer.fileName)}
          </ThemedText>
        </View>
      )}
      <View style={styles.flex1}>
        <ThemedText type="small" numberOfLines={1}>
          {transfer.fileName}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {sent ? `To ${other}` : `From ${other}`} · {formatBytes(transfer.fileSize)}
          {received?.inGallery ? ' · in gallery' : received?.inDownloads ? ' · in Downloads' : ''} ·{' '}
          <ThemedText type="small" style={{ color: failed ? '#e5484d' : '#30a46c' }}>
            {statusWord}
          </ThemedText>
        </ThemedText>
      </View>
      {received && (
        <Pressable onPress={share} hitSlop={Spacing.two}>
          <ThemedText type="small" style={{ color: Accent }}>
            Share
          </ThemedText>
        </Pressable>
      )}
    </Pressable>
  );
}

// --- main screen ---

function Main() {
  const user = useAuth((s) => s.user)!;
  const logout = useAuth((s) => s.logout);
  const [wsConnected, setWsConnected] = useState(zapWs.connected);
  const [addFriendOpen, setAddFriendOpen] = useState(false);

  const refreshFriends = useFriends((s) => s.refresh);
  const redeemCode = useFriends((s) => s.redeemCode);
  const { transfers, loading, refresh } = useTransfers();

  // QR pairing via deep link: zapfileapp://?pair=CODE (system camera scans).
  const url = Linking.useURL();
  const handledUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!url || url === handledUrl.current) return;
    handledUrl.current = url;
    const pair = Linking.parse(url).queryParams?.pair;
    const code = typeof pair === 'string' ? pair : Array.isArray(pair) ? pair[0] : null;
    if (!code) return;
    redeemCode(code)
      .then(() => Alert.alert('Friend request sent', 'Waiting for them to accept.'))
      .catch((e) =>
        Alert.alert('Could not add friend', e instanceof Error ? e.message : 'Invalid code'),
      );
  }, [url, redeemCode]);

  useEffect(() => {
    const offUp = zapWs.on('ws.connected', () => setWsConnected(true));
    const offDown = zapWs.on('ws.disconnected', () => setWsConnected(false));
    refreshFriends();
    refresh();
    return () => {
      offUp();
      offDown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.userId]);

  // a transfer whose bytes all arrived is done for UI purposes, even if the
  // status update never landed (old zombie rows stuck at IN_PROGRESS)
  const isMoving = (t: TransferResponse) =>
    (t.status === 'IN_PROGRESS' || t.status === 'ACCEPTED') &&
    !(t.fileSize > 0 && t.bytesTransferred >= t.fileSize);

  const incoming = useMemo(() => incomingOffers(transfers, user.userId), [transfers, user.userId]);
  const outgoing = useMemo(() => outgoingOffers(transfers, user.userId), [transfers, user.userId]);
  const active = useMemo(() => transfers.filter(isMoving), [transfers]);
  const settled = useMemo(
    () =>
      [...transfers]
        .filter((t) => t.status !== 'OFFERED' && !isMoving(t))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [transfers],
  );

  const onRefresh = () => {
    refreshFriends();
    refresh();
  };

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}>
        <View style={styles.header}>
          <ThemedText type="subtitle" style={{ color: Accent }}>
            ZapFile
          </ThemedText>
          <View style={styles.flex1} />
          <View style={[styles.statusDot, { backgroundColor: wsConnected ? '#30a46c' : '#e5484d' }]} />
          <Pressable onPress={logout}>
            <ThemedText type="small" themeColor="textSecondary">
              Log out
            </ThemedText>
          </Pressable>
        </View>

        {incoming.map((b) => (
          <IncomingOfferCard key={b.batchId} batch={b} />
        ))}

        <SendDirectly onAddFriend={() => setAddFriendOpen(true)} />

        {(outgoing.length > 0 || active.length > 0) && (
          <View style={styles.section}>
            {outgoing.map((b) => (
              <OutgoingOfferCard key={b.batchId} batch={b} />
            ))}
            {active.map((t) => (
              <ActiveRow key={t.id} transfer={t} myUserId={user.userId} />
            ))}
          </View>
        )}

        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Received & sent
          </ThemedText>
          {settled.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Nothing yet — tap a friend to send files.
            </ThemedText>
          ) : (
            settled.map((t) => <HistoryItem key={t.id} transfer={t} myUserId={user.userId} />)
          )}
        </View>
      </ScrollView>
      <AddFriendModal visible={addFriendOpen} onClose={() => setAddFriendOpen(false)} />
    </>
  );
}

export default function HomeScreen() {
  const { ready, user, restore } = useAuth();

  useEffect(() => {
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {!ready ? (
          <View style={styles.authWrap}>
            <ActivityIndicator size="large" color={Accent} />
          </View>
        ) : user ? (
          <Main />
        ) : (
          <AuthForm />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    width: '100%',
  },
  authWrap: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  scrollContent: {
    gap: Spacing.four,
    padding: Spacing.four,
    paddingBottom: Spacing.six,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  section: {
    gap: Spacing.three,
  },
  bubbleRow: {
    gap: Spacing.four,
    paddingVertical: Spacing.one,
  },
  bubble: {
    alignItems: 'center',
    gap: Spacing.one,
    width: 72,
  },
  bubbleLabel: {
    textAlign: 'center',
  },
  bubbleSpinner: {
    ...StyleSheet.absoluteFill,
    borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: Accent,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: {
    color: Accent,
    fontSize: 28,
    lineHeight: 32,
  },
  requestBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#e5484d',
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  offerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  offerTitle: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  flex1: {
    flex: 1,
  },
  cancelX: {
    lineHeight: 32,
    paddingHorizontal: Spacing.two,
  },
  rowThumbnail: {
    width: 56,
    height: 56,
    borderRadius: Spacing.two + 2,
    backgroundColor: '#1a1a1d',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  extBadge: {
    width: 56,
    height: 56,
    borderRadius: Spacing.two + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    textAlign: 'center',
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
  button: {
    backgroundColor: Accent,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
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
});

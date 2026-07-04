import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface Props {
  name: string;
  size?: number;
  /** undefined hides the presence dot */
  online?: boolean;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Blip-style round avatar with initials and an optional presence dot. */
export function Avatar({ name, size = 64, online }: Props) {
  const theme = useTheme();
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: Accent },
        ]}>
        <ThemedText style={[styles.initials, { fontSize: size * 0.34 }]}>
          {initials(name)}
        </ThemedText>
      </View>
      {online !== undefined && (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: size * 0.14,
              borderColor: theme.background,
              backgroundColor: online ? '#30a46c' : '#5f6368',
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#fff',
    fontWeight: '700',
  },
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    borderWidth: 2.5,
  },
});

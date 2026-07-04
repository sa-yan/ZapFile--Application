import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

// Tiny JSON-file persistence for store state that must survive app restarts
// (SecureStore is for secrets and caps values at ~2KB; this has no such limit).

export function loadJson<T>(name: string): T | null {
  if (Platform.OS === 'web') return null;
  try {
    const file = new File(Paths.document, name);
    if (!file.exists) return null;
    return JSON.parse(file.textSync()) as T;
  } catch {
    return null;
  }
}

export function saveJson(name: string, value: unknown): void {
  if (Platform.OS === 'web') return;
  try {
    const file = new File(Paths.document, name);
    file.write(JSON.stringify(value));
  } catch (e) {
    console.warn(`could not persist ${name}:`, e instanceof Error ? e.message : e);
  }
}

// Remote push targets the phones; the web build doesn't register a token.
export async function getPushToken(): Promise<string | null> {
  return null;
}

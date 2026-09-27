export default async function globalTeardown(): Promise<void> {
  await globalThis.__POSTGRES__?.stop();
}

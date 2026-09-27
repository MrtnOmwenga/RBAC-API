import { hash, verify } from '@node-rs/argon2';

// Argon2id with the OWASP-recommended minimum (19 MiB, 2 passes, 1 lane).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

// Verified against when the email is unknown, so a miss costs as much time as a wrong password.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  if (passwordHash === null) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(passwordHash, password).catch(() => false);
}

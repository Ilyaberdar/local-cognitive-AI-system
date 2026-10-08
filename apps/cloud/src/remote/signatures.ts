import { createPublicKey, verify } from "node:crypto";

/** Every host signature covers `context ‖ 0x00 ‖ message`, so a signature made for one purpose
 * never verifies for another. The host side signs with the same contexts (src/remote/messages.ts). */
export const SIGNATURE_CONTEXT = {
  register: "lc-host-register/v1",
  relayAuth: "lc-relay-host-auth/v1",
  claim: "lc-claim-receipt/v1",
  revoke: "lc-host-revoke/v1"
} as const;

export const verifyHostSignature = (publicKey: Buffer, context: string, message: Buffer, signature: Buffer): boolean => {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.concat([Buffer.from(context), Buffer.from([0]), message]), key, signature);
  } catch { return false; }
};

/** What a host signs to authenticate its control connection: binds the nonce to this Cloud. */
export const relayAuthMessage = (hostId: string, nonce: string, origin: string): Buffer => Buffer.from(JSON.stringify([hostId, nonce, origin]));

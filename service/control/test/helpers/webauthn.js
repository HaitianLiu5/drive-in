import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// A software authenticator: answers registration options with a fresh P-256
// passkey and a "none" attestation, so registration runs end to end in Node.
export function createCredential(options, origin) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y } = publicKey.export({ format: "jwk" });
  // COSE_Key: kty EC2, alg ES256, crv P-256, x, y.
  const coseKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(x)], [-3, isoBase64URL.toBuffer(y)]]));
  const credentialId = randomBytes(16);
  const authData = Buffer.concat([
    createHash("sha256").update(options.rp.id).digest(),
    Buffer.from([0x01 | 0x04 | 0x40]), // user present, user verified, attested credential data
    Buffer.alloc(4), // sign count
    Buffer.alloc(16), // AAGUID
    Buffer.from([0, credentialId.length]),
    credentialId,
    coseKey,
  ]);
  const attestationObject = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]));
  const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromUTF8String(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
    },
  };
}

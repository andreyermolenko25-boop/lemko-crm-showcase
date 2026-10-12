/**
 * Passkeys (WebAuthn): the server sends options as JSON with base64url strings;
 * the browser API wants ArrayBuffers, and the answer goes back as JSON again.
 */

type Json = Record<string, unknown>

function fromB64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return bytes.buffer
}

function toB64url(buffer: ArrayBuffer | null | undefined): string | null {
  if (!buffer) return null
  let binary = ""
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list.map((item: Json) => ({
    type: "public-key",
    id: fromB64url(String(item.id)),
    transports: item.transports as AuthenticatorTransport[] | undefined,
  }))
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials
}

/** Registers a new passkey; returns the credential as JSON for the server. */
export async function createPasskey(options: Json): Promise<Json> {
  const user = options.user as Json
  const publicKey = {
    ...(options as object),
    challenge: fromB64url(String(options.challenge)),
    user: { ...(user as object), id: fromB64url(String(user.id)) },
    excludeCredentials: descriptors(options.excludeCredentials),
  } as PublicKeyCredentialCreationOptions
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  if (!credential) throw new Error("cancelled")
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      attestationObject: toB64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  }
}

/** Signs a sign-in challenge with an existing passkey. */
export async function getPasskey(options: Json): Promise<Json> {
  const publicKey = {
    ...(options as object),
    challenge: fromB64url(String(options.challenge)),
    allowCredentials: descriptors(options.allowCredentials),
  } as PublicKeyCredentialRequestOptions
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!credential) throw new Error("cancelled")
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
      userHandle: toB64url(response.userHandle),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  }
}

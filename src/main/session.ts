import { FIXED_USER_AGENT } from "./user-agent.ts";

// One persistent session partition for the whole host. The exact on-disk
// profile path is owned by a later todo; this constant only names the
// partition so every window shares a single persistent session.
export const IDENTITY_PARTITION = "persist:youtubetv";

// Structural view of the Electron session surface this policy needs. Kept
// structural (instead of importing Electron types) so the policy stays
// unit-testable without the Electron runtime.
export interface IdentityPolicySession {
  setUserAgent(userAgent: string): void;
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: { requestHeaders: Record<string, string> },
        callback: (response: {
          requestHeaders: Record<string, string>;
        }) => void,
      ) => void,
    ): void;
  };
}

export interface IdentityPolicyEvidence {
  userAgent: string;
  headerInterceptionActive: boolean;
}

// Activates the fixed identity on the session: sets the session user agent
// and forces the User-Agent request header on every request, normalising any
// pre-existing casing variant first. Returns evidence only after both are in
// place; any failure throws so the caller can refuse to load the target.
export function activateIdentityPolicy(
  session: IdentityPolicySession,
): IdentityPolicyEvidence {
  session.setUserAgent(FIXED_USER_AGENT);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "user-agent") {
        delete headers[name];
      }
    }
    headers["User-Agent"] = FIXED_USER_AGENT;
    callback({ requestHeaders: headers });
  });
  return { userAgent: FIXED_USER_AGENT, headerInterceptionActive: true };
}

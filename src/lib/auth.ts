import { initializeApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
] as const;

export interface AuthUserProfile {
  displayName: string | null;
  email: string | null;
  photoURL?: string | null;
}

const provider = new GoogleAuthProvider();
for (const scope of WORKSPACE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

let isSigningIn = false;
// Strictly in-memory token cache (never stored in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: {
              access_token?: string;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
          revoke?: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

export class GoogleAuthFlowError extends Error {
  code: string;
  canRetryWithDirectGis: boolean;

  constructor(message: string, code: string, canRetryWithDirectGis = false) {
    super(message);
    this.name = 'GoogleAuthFlowError';
    this.code = code;
    this.canRetryWithDirectGis = canRetryWithDirectGis;
  }
}

function mapFirebaseAuthError(err: unknown): GoogleAuthFlowError {
  const fbErr = err as { code?: string; message?: string };
  const code = fbErr?.code || 'auth/unknown';

  switch (code) {
    case 'auth/popup-blocked':
      return new GoogleAuthFlowError(
        'Your browser blocked the Google sign-in popup. Allow popups for this site or use Direct Google Sign-In.',
        code,
        true
      );
    case 'auth/popup-closed-by-user':
      return new GoogleAuthFlowError(
        'The Google sign-in window closed before completing authentication. Please try again or use Direct Google Sign-In.',
        code,
        true
      );
    case 'auth/cancelled-popup-request':
      return new GoogleAuthFlowError(
        'Another sign-in popup was already open. Please try again.',
        code,
        false
      );
    case 'auth/unauthorized-domain':
      return new GoogleAuthFlowError(
        `This domain (${window.location.hostname}) is not authorized for Firebase popup auth. Try Direct Google Sign-In.`,
        code,
        true
      );
    case 'auth/internal-error':
    case 'auth/operation-not-supported-in-this-environment':
      return new GoogleAuthFlowError(
        'Firebase popup authentication could not initialize in this browser context. Try Direct Google Sign-In.',
        code,
        true
      );
    default:
      return new GoogleAuthFlowError(
        fbErr?.message || 'Google sign-in failed. Please try again.',
        code,
        true
      );
  }
}

function toUserProfile(user: User): AuthUserProfile {
  return {
    displayName: user.displayName,
    email: user.email,
    photoURL: user.photoURL,
  };
}

export const initAuth = (
  onAuthSuccess?: (user: AuthUserProfile, token: string) => void,
  onAuthFailure?: (user: AuthUserProfile | null) => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess?.(toUserProfile(user), cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.(toUserProfile(user));
      }
    } else if (!cachedAccessToken) {
      onAuthFailure?.(null);
    }
  });
};

export const googleSignIn = async (): Promise<{
  user: AuthUserProfile;
  accessToken: string;
}> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(
      auth,
      provider,
      browserPopupRedirectResolver
    );
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new GoogleAuthFlowError(
        'Google Workspace Drive & Sheets permissions were not returned. Please grant access or use Direct Google Sign-In.',
        'auth/missing-access-token',
        true
      );
    }
    cachedAccessToken = credential.accessToken;
    return { user: toUserProfile(result.user), accessToken: cachedAccessToken };
  } catch (err: unknown) {
    if (err instanceof GoogleAuthFlowError) {
      throw err;
    }
    throw mapFirebaseAuthError(err);
  } finally {
    isSigningIn = false;
  }
};

export const googleSignInDirectGis = async (): Promise<{
  user: AuthUserProfile;
  accessToken: string;
}> => {
  const oauth2 = window.google?.accounts?.oauth2;
  const clientId = firebaseConfig.oAuthClientId;

  if (!oauth2 || !clientId) {
    throw new GoogleAuthFlowError(
      'Google Identity Services is still loading or unavailable. Please refresh the page and allow popups.',
      'gis/unavailable',
      false
    );
  }

  const accessToken = await new Promise<string>((resolve, reject) => {
    try {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: WORKSPACE_SCOPES.join(' '),
        callback: (resp) => {
          if (resp.error) {
            reject(
              new GoogleAuthFlowError(
                resp.error_description || `Google authorization failed (${resp.error}).`,
                resp.error,
                false
              )
            );
            return;
          }
          if (!resp.access_token) {
            reject(
              new GoogleAuthFlowError(
                'No Google Workspace access token was returned.',
                'gis/no-token',
                false
              )
            );
            return;
          }
          resolve(resp.access_token);
        },
        error_callback: (err) => {
          reject(
            new GoogleAuthFlowError(
              err?.message || 'Google authorization popup was blocked or closed.',
              err?.type || 'gis/popup-error',
              false
            )
          );
        },
      });
      client.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      reject(
        new GoogleAuthFlowError(
          err instanceof Error ? err.message : 'Unable to start Google sign-in.',
          'gis/init-error',
          false
        )
      );
    }
  });

  cachedAccessToken = accessToken;

  let profile: AuthUserProfile = {
    displayName: 'Google Workspace User',
    email: null,
  };

  try {
    const aboutRes = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (aboutRes.ok) {
      const aboutData = await aboutRes.json();
      if (aboutData?.user) {
        profile = {
          displayName: aboutData.user.displayName || 'Google Workspace User',
          email: aboutData.user.emailAddress || null,
          photoURL: aboutData.user.photoLink || null,
        };
      }
    }
  } catch {
    // Non-fatal; Drive & Sheets calls will still work with the access token
  }

  return { user: profile, accessToken };
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const clearAccessToken = () => {
  cachedAccessToken = null;
};

export const logout = async () => {
  const tokenToRevoke = cachedAccessToken;
  cachedAccessToken = null;
  if (tokenToRevoke && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(tokenToRevoke);
    } catch {
      // Ignore revoke errors
    }
  }
  await auth.signOut();
};

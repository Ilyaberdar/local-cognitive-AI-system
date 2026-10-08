import { z } from "zod";

export interface AccountConfig {
  /** https://<tenant domain>, without a trailing slash. */
  authority: string;
  /** Token issuer: the authority with a trailing slash. */
  issuer: string;
  clientId: string;
  audience: string;
  scope: string;
  callbackPort: number;
  /** Local Cognitive Cloud API; sign-in is unavailable without it. */
  cloudUrl?: string;
}

export const ACCOUNT_CALLBACK_PORT = 17850;

// Public values of the Auth0 Native application (PKCE, no client secret).
const tenant = { domain: "dev-1r1wg4zfij4lam4r.eu.auth0.com", clientId: "f2AA24WqGaB3QF1UXFP7HQMRI5DBfHC0", audience: "https://api.local-cognitive.com" };
// Deployed on the Oracle host behind its Caddy (deploy/cloud/README.md).
const productionCloudUrl: string | undefined = "https://api.local-cognitive.com";
const developmentCloudUrl = "http://127.0.0.1:8080";

const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
const cloudUrl = z.string().url().refine(value => value.startsWith("https://") || loopback.test(value.replace(/\/$/, "")), "Cloud URL must use https or loopback http.");

/** Development builds may override the tenant and Cloud through the environment; packaged builds may not. */
export const resolveAccountConfig = ({ env, packaged }: { env: NodeJS.ProcessEnv; packaged: boolean }): AccountConfig => {
  const domain = (!packaged && env.LOCAL_COGNITIVE_AUTH0_DOMAIN) || tenant.domain;
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error("Invalid Auth0 domain.");
  const authority = `https://${domain}`;
  const cloud = packaged ? productionCloudUrl : env.LOCAL_COGNITIVE_CLOUD_URL || developmentCloudUrl;
  return {
    authority, issuer: `${authority}/`,
    clientId: (!packaged && env.LOCAL_COGNITIVE_AUTH0_CLIENT_ID) || tenant.clientId,
    audience: (!packaged && env.LOCAL_COGNITIVE_AUTH0_AUDIENCE) || tenant.audience,
    scope: "openid profile email offline_access",
    callbackPort: ACCOUNT_CALLBACK_PORT,
    cloudUrl: cloud ? cloudUrl.parse(cloud).replace(/\/$/, "") : undefined
  };
};

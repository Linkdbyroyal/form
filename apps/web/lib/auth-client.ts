import { adminClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser client. Base URL defaults to the current origin, which is where /api/auth lives. */
export const authClient = createAuthClient({
  plugins: [
    organizationClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window !== "undefined") window.location.href = "/two-factor";
      }
    }),
    adminClient()
  ]
});

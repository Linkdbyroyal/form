import Link from "next/link";
import { AuthLayout } from "@/components/auth-layout";
import { ResendVerificationForm } from "./resend-form";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ verified?: string; error?: string; email?: string }> }) {
  const params = await searchParams;
  if (params.verified) {
    return (
      <AuthLayout title="E-mail verified" intro="Your e-mail address is confirmed. You can sign in now.">
        <Link href="/sign-in" className="text-sm underline">Go to sign-in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Verify your e-mail address"
      intro="Accounts must confirm their e-mail address before the first sign-in. Open the link in the verification message; it expires after one hour."
      footer="Without RESEND_API_KEY the message is printed to the server console with the prefix [mail:dev]."
    >
      {params.error ? <p className="mb-3 text-sm text-danger">Verification failed: {params.error}. Request a new link below.</p> : null}
      <ResendVerificationForm defaultEmail={params.email ?? ""} />
    </AuthLayout>
  );
}

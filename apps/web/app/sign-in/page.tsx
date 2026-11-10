import { redirect } from "next/navigation";
import { AccountMenu } from "@/components/account-menu";
import { AuthLayout } from "@/components/auth-layout";
import { configuredSocialProviders } from "@/lib/auth";
import { getSession } from "@/lib/request-context";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

function safeNext(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; signed_out?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const session = await getSession();
  if (session) redirect(next);
  return (
    <AuthLayout account={<AccountMenu align="right" />}
      title="Sign in"
      intro="Accounts are created by invitation only. Your e-mail address must be verified before the first sign-in."
      footer={params.signed_out ? "You have been signed out." : "Operators (superadmin, agency operator) must enable TOTP before Mission Control opens."}
    >
      <SignInForm next={next} providers={configuredSocialProviders()} />
    </AuthLayout>
  );
}

import Link from "next/link";
import { AccountMenu } from "@/components/account-menu";
import { AuthLayout } from "@/components/auth-layout";
import { Badge } from "@/components/ui";
import { getSession } from "@/lib/request-context";
import { loadInvitation } from "./invitation";
import { AcceptInvitationButton, InvitationSignUpForm } from "./invitation-client";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = await loadInvitation(id);
  if (!inv) {
    return <AuthLayout account={<AccountMenu align="right" />} title="Invitation not found" intro="This invitation does not exist or was removed." />;
  }
  const expired = inv.expiresAt.getTime() < Date.now();
  const summary = (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Organisation</span><span className="font-medium">{inv.organizationName}</span>
      <Badge tone="cyan">{inv.role}</Badge>
      <span className="text-muted">for</span><span className="font-medium">{inv.email}</span>
    </div>
  );
  if (inv.status !== "pending" || expired) {
    return (
      <AuthLayout account={<AccountMenu align="right" />} title="Invitation unavailable" intro={expired ? "This invitation has expired. Ask the organisation administrator for a new one." : `This invitation is ${inv.status}.`}>
        {summary}
      </AuthLayout>
    );
  }
  const session = await getSession();
  const destination = inv.organizationSlug === "second-brain-agency" ? "/mission-control" : `/c/${inv.organizationSlug}`;

  if (session) {
    if (session.user.email.toLowerCase() !== inv.email.toLowerCase()) {
      return (
        <AuthLayout account={<AccountMenu align="right" />} title="Signed in with another account" intro={`You are signed in as ${session.user.email}, but this invitation is for ${inv.email}.`}>
          {summary}
          <form method="post" action="/sign-out"><button type="submit" className="text-sm underline">Sign out and switch account</button></form>
        </AuthLayout>
      );
    }
    return (
      <AuthLayout account={<AccountMenu align="right" />} title="Accept invitation" intro="Accepting adds you as a member; your role is mirrored into the platform's own membership table.">
        {summary}
        <AcceptInvitationButton invitationId={inv.id} destination={destination} />
      </AuthLayout>
    );
  }

  if (inv.accountExists) {
    return (
      <AuthLayout account={<AccountMenu align="right" />} title="Sign in to accept" intro="An account exists for this address. Sign in and you return here to accept.">
        {summary}
        <Link href={`/sign-in?next=${encodeURIComponent(`/accept-invitation/${inv.id}`)}`} className="text-sm underline">Sign in</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout account={<AccountMenu align="right" />} title="Create your account" intro="Public sign-up is disabled; this invitation lets you create an account for the invited address. You verify the address by e-mail, sign in, and return here to accept." footer="Without RESEND_API_KEY the verification mail is printed to the server console with the prefix [mail:dev].">
      {summary}
      <InvitationSignUpForm invitationId={inv.id} email={inv.email} />
    </AuthLayout>
  );
}
